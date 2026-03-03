"""
ssb_api.py — Behavioral spam detection for YouTube comments
===========================================================
Detects scam bots based on:
  1. Account age / subscriber count (YouTube Channels API)
  2. Duplicate/near-duplicate text across authors (full comment)
  3. Duplicate tail sentences across authors (appended scam phrase pattern)
  4. Coordinated burst timing from new accounts
  5. Reply chain collusion between suspicious accounts
  6. Profile picture explicit content (nudenet, local)

Key design decisions:
  - Subscriber/video signals only fire when account age is ALSO new,
    preventing false positives from legitimate lurker accounts.
  - Tail-duplicate detection catches the "legitimate comment + appended scam
    phrase" pattern without relying on brand-name keywords. Works generically
    across any crypto/investment scam name.
  - No hard-coded brand names or product keywords in scoring logic.
"""
import os, re, time, json, logging, asyncio
from typing import List, Optional, Dict, Any
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from collections import defaultdict

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("ssb")

# ── config ────────────────────────────────────────────────────────────────────
YOUTUBE_API_KEY       = os.getenv("YOUTUBE_API_KEY", "AIzaSyCGcr49yvh58hOHMJsnzB7gxUP5YNxH2wI")
YOUTUBE_CHANNELS_URL  = "https://www.googleapis.com/youtube/v3/channels"

SCAM_SCORE_THRESHOLD  = int(os.getenv("SSB_THRESHOLD", "60"))
CACHE_FILE            = os.getenv("SSB_CACHE_FILE", "ssb_channel_cache.json")
CACHE_TTL             = int(os.getenv("SSB_CACHE_TTL", "86400"))   # 24h

# nudenet — lazy loaded on first use
NUDENET_AVAILABLE  = False
NUDENET_CLASSIFIER = None

# sentence-transformers — lazy loaded on first use
# Model: all-MiniLM-L6-v2 (~80MB, downloads once, cached locally)
# Detects semantic incoherence between comment body and tail sentence.
COHERENCE_AVAILABLE = False
COHERENCE_MODEL     = None

# ── scoring weights ───────────────────────────────────────────────────────────
W_ACCOUNT_VERY_NEW    = 45   # account < 30 days old
W_ACCOUNT_NEW         = 25   # account < 90 days old
W_ZERO_SUBSCRIBERS    = 20   # 0 subscribers AND new account
W_ZERO_VIDEOS         = 15   # channel has no videos AND new account
W_ZERO_LIKES_NEW      = 10   # 0 likes AND new account
W_DUPLICATE_TEXT      = 35   # near-identical full comment from different authors
W_DUPLICATE_TAIL      = 65   # near-identical final sentence from different authors
                              # (weighted higher: appended scam phrases are a very precise signal)
W_BURST_TIMING        = 25   # 3+ new accounts posting within 60s window
W_COLLUSION_REPLY     = 20   # replying to/from another suspicious account
W_EXPLICIT_PFP        = 50   # nudenet flagged profile picture
W_INCOHERENT_TAIL     = 35   # tail semantically unrelated to comment body (embedding cosine)

# Theoretical maximum score (sum of all weights) — used to normalise to 0.0–1.0
MAX_SCORE = (W_ACCOUNT_VERY_NEW + W_ZERO_SUBSCRIBERS + W_ZERO_VIDEOS + W_ZERO_LIKES_NEW +
             W_DUPLICATE_TEXT + W_DUPLICATE_TAIL + W_INCOHERENT_TAIL +
             W_BURST_TIMING + W_EXPLICIT_PFP + W_COLLUSION_REPLY)  # = 320

BURST_WINDOW_SECS     = 60   # seconds window for burst detection
BURST_MIN_COUNT       = 3    # minimum accounts in burst to trigger
DUP_SIMILARITY        = 0.80 # full-text similarity threshold (0-1)
TAIL_SIMILARITY       = 0.75 # tail similarity threshold (slightly looser — tails are short)
TAIL_MIN_LEN          = 15   # minimum characters in a tail to bother comparing
TAIL_MIN_AUTHORS      = 4    # minimum distinct authors sharing same tail to flag
                              # eliminates topical repeats ("no nfc is crazy") while
                              # keeping coordinated bot campaigns (typically 4-10 authors)
COHERENCE_THRESHOLD   = 0.30 # cosine similarity below this = incoherent tail
                              # tuned conservatively — only fires on clear topic shifts
COHERENCE_BODY_MIN    = 40   # min body characters to bother running coherence check
NEW_ACCOUNT_DAYS      = 90   # days threshold for "new account"
VERY_NEW_ACCOUNT_DAYS = 30   # days threshold for "very new account"

# ── models ────────────────────────────────────────────────────────────────────
class CommentIn(BaseModel):
    comment_id:               str
    text:                     str
    author:                   str
    author_channel_id:        Optional[str] = None
    author_profile_image_url: Optional[str] = None
    publish_timestamp:        Optional[int] = None   # ms since epoch
    like_count:               Optional[int] = None
    parent_comment_id:        Optional[str] = None

class AnalyzeRequest(BaseModel):
    comments: List[CommentIn]

class CommentResult(BaseModel):
    comment_id: str
    label:      str           # SCAM | HAM
    score:      int
    tactic:     Optional[str]
    signals:    List[str]

# ── channel cache ─────────────────────────────────────────────────────────────
class ChannelCache:
    """Caches YouTube channel stats to avoid redundant API calls."""
    def __init__(self, ttl: int = 86400):
        self.ttl        = ttl
        self.cache:      Dict[str, Any]   = {}
        self.timestamps: Dict[str, float] = {}
        self._load()

    def _load(self):
        if os.path.exists(CACHE_FILE):
            try:
                data = json.load(open(CACHE_FILE))
                now  = time.time()
                for k, e in data.items():
                    if now - e.get("ts", 0) < self.ttl:
                        self.cache[k]      = e["data"]
                        self.timestamps[k] = e["ts"]
                log.info("Loaded %d channel records from cache", len(self.cache))
            except Exception as ex:
                log.warning("Channel cache load failed: %s", ex)

    def save(self):
        try:
            json.dump(
                {k: {"data": self.cache[k], "ts": self.timestamps[k]} for k in self.cache},
                open(CACHE_FILE, "w"),
            )
        except Exception as ex:
            log.warning("Channel cache save failed: %s", ex)

    def get(self, channel_id: str) -> Optional[Dict]:
        if channel_id in self.cache:
            if time.time() - self.timestamps.get(channel_id, 0) < self.ttl:
                return self.cache[channel_id]
        return None

    def set(self, channel_id: str, data: Dict):
        self.cache[channel_id]      = data
        self.timestamps[channel_id] = time.time()

# ── fastapi app ───────────────────────────────────────────────────────────────
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

CHANNEL_CACHE: Optional[ChannelCache] = None
EXECUTOR = ThreadPoolExecutor(max_workers=4)

@app.on_event("startup")
def startup():
    global CHANNEL_CACHE, NUDENET_AVAILABLE, NUDENET_CLASSIFIER
    global COHERENCE_AVAILABLE, COHERENCE_MODEL
    CHANNEL_CACHE = ChannelCache(ttl=CACHE_TTL)

    try:
        from nudenet import NudeDetector
        NUDENET_CLASSIFIER = NudeDetector()
        NUDENET_AVAILABLE  = True
        log.info("nudenet loaded — profile picture analysis enabled")
    except ImportError:
        log.warning("nudenet not installed — profile picture analysis disabled. Run: pip install nudenet")
    except Exception as ex:
        log.warning("nudenet failed to load: %s", ex)

    try:
        from sentence_transformers import SentenceTransformer
        COHERENCE_MODEL     = SentenceTransformer("all-MiniLM-L6-v2")
        COHERENCE_AVAILABLE = True
        log.info("sentence-transformers loaded — semantic coherence analysis enabled")
    except ImportError:
        log.warning("sentence-transformers not installed — coherence check disabled. Run: pip install sentence-transformers")
    except Exception as ex:
        log.warning("sentence-transformers failed to load: %s", ex)

    if not YOUTUBE_API_KEY:
        log.warning("YOUTUBE_API_KEY not set — channel stats unavailable, behavioral scoring degraded")

    log.info("SSB behavioral API ready | threshold=%d | nudenet=%s | coherence=%s",
             SCAM_SCORE_THRESHOLD, NUDENET_AVAILABLE, COHERENCE_AVAILABLE)

@app.on_event("shutdown")
def shutdown():
    if CHANNEL_CACHE:
        CHANNEL_CACHE.save()
    EXECUTOR.shutdown(wait=True)

@app.get("/health")
def health():
    return {
        "ok":                 True,
        "mode":               "behavioral",
        "nudenet":            NUDENET_AVAILABLE,
        "coherence":          COHERENCE_AVAILABLE,
        "youtube_api":        bool(YOUTUBE_API_KEY),
        "threshold":          SCAM_SCORE_THRESHOLD,
        "channel_cache_size": len(CHANNEL_CACHE.cache) if CHANNEL_CACHE else 0,
        "ts":                 time.time(),
    }

@app.post("/cache/clear")
def clear_cache():
    CHANNEL_CACHE.cache.clear()
    CHANNEL_CACHE.timestamps.clear()
    CHANNEL_CACHE.save()
    return {"status": "cleared"}

# ── youtube channels API ──────────────────────────────────────────────────────
async def fetch_channel_stats(channel_ids: List[str]) -> Dict[str, Dict]:
    """
    Fetch channel statistics for a list of channel IDs.
    Batches up to 50 per API call (1 quota unit per call).
    Returns dict of channel_id -> stats.
    """
    if not YOUTUBE_API_KEY or not channel_ids:
        return {}

    results: Dict[str, Dict] = {}
    uncached = []
    for cid in channel_ids:
        cached = CHANNEL_CACHE.get(cid)
        if cached:
            results[cid] = cached
        else:
            uncached.append(cid)

    if not uncached:
        return results

    log.info("Fetching channel stats for %d channels (%d cached)", len(uncached), len(results))

    async with httpx.AsyncClient(timeout=10.0) as client:
        for i in range(0, len(uncached), 50):
            batch = uncached[i:i + 50]
            try:
                resp = await client.get(YOUTUBE_CHANNELS_URL, params={
                    "part": "snippet,statistics",
                    "id":   ",".join(batch),
                    "key":  YOUTUBE_API_KEY,
                })
                data = resp.json()

                for item in data.get("items", []):
                    cid     = item["id"]
                    snippet = item.get("snippet",    {})
                    stats   = item.get("statistics", {})
                    channel_data = {
                        "created_at":       snippet.get("publishedAt"),
                        "subscriber_count": int(stats.get("subscriberCount", 0)),
                        "video_count":      int(stats.get("videoCount",      0)),
                        "comment_count":    int(stats.get("commentCount",    0)),
                        "title":            snippet.get("title", ""),
                    }
                    results[cid] = channel_data
                    CHANNEL_CACHE.set(cid, channel_data)

                # Channels absent from API response are deleted/private — ghost accounts
                returned_ids = {item["id"] for item in data.get("items", [])}
                for cid in batch:
                    if cid not in returned_ids:
                        ghost = {"created_at": None, "subscriber_count": 0,
                                 "video_count": 0, "comment_count": 0, "title": ""}
                        results[cid] = ghost
                        CHANNEL_CACHE.set(cid, ghost)

            except Exception as ex:
                log.warning("Channel API batch failed: %s", ex)

    CHANNEL_CACHE.save()
    return results

# ── nudenet profile picture analysis ─────────────────────────────────────────
EXPLICIT_CLASSES = {
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "BUTTOCKS_EXPOSED",
    "ANUS_EXPOSED",
}

def check_profile_picture_sync(image_url: str) -> bool:
    """Returns True if profile picture is flagged as explicit. Runs in thread pool."""
    if not NUDENET_AVAILABLE or not image_url:
        return False
    try:
        import urllib.request, tempfile
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            urllib.request.urlretrieve(image_url, f.name)
            detections = NUDENET_CLASSIFIER.detect(f.name)
            os.unlink(f.name)
        # Flag if any explicit body part detected with confidence > 0.6
        for det in detections:
            if det.get("class") in EXPLICIT_CLASSES and det.get("score", 0) > 0.6:
                return True
        return False
    except Exception as ex:
        log.debug("Profile picture check failed: %s", ex)
        return False

async def check_profile_picture(image_url: str) -> bool:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(EXECUTOR, check_profile_picture_sync, image_url)

# ── behavioral helpers ────────────────────────────────────────────────────────
def account_age_days(created_at: Optional[str]) -> Optional[int]:
    """Parse ISO date string and return age in days."""
    if not created_at:
        return None
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).days
    except Exception:
        return None


def _ngram_shingles(text: str, n: int = 4) -> set:
    return {text[i:i + n] for i in range(len(text) - n + 1)}


def find_duplicate_groups(comments: List[CommentIn]) -> set:
    """
    Find comment IDs whose FULL text is near-identical to another author's comment.
    Uses 4-gram shingle bucketing as a pre-filter before SequenceMatcher.
    """
    bucket:  Dict[str, list] = defaultdict(list)
    entries: list             = []

    for c in comments:
        if not c.text or len(c.text.strip()) <= 20:
            continue
        t        = c.text.strip().lower()
        shingles = _ngram_shingles(t)
        for key in sorted(shingles)[:5]:
            bucket[key].append((c.comment_id, c.author, t, shingles))
        entries.append((c.comment_id, c.author, t, shingles))

    candidate_pairs: set = set()
    for items in bucket.values():
        if len(items) < 2:
            continue
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, b = items[i], items[j]
                if a[1] != b[1]:
                    candidate_pairs.add((min(a[0], b[0]), max(a[0], b[0])))

    id_to_entry = {e[0]: e for e in entries}
    flagged: set = set()

    for cid_a, cid_b in list(candidate_pairs)[:5000]:
        a = id_to_entry.get(cid_a)
        b = id_to_entry.get(cid_b)
        if not a or not b:
            continue
        union = len(a[3] | b[3])
        if union and (len(a[3] & b[3]) / union) >= DUP_SIMILARITY * 0.7:
            if SequenceMatcher(None, a[2], b[2]).ratio() >= DUP_SIMILARITY:
                flagged.add(cid_a)
                flagged.add(cid_b)

    return flagged


def extract_tail(text: str) -> str:
    """
    Extract the last meaningful sentence from a comment.

    Scam bots using the "copy a real comment + append scam phrase" attack
    always put their payload at the end. Isolating the tail lets us detect
    this structurally, without knowing the scam brand name.
    """
    sentences = re.split(r'[.!?\n]+', text.strip())
    sentences = [s.strip() for s in sentences if len(s.strip()) >= TAIL_MIN_LEN]
    return sentences[-1].lower() if sentences else ""


def find_tail_duplicate_ids(comments: List[CommentIn]) -> set:
    """
    Find comment IDs whose FINAL SENTENCE is near-identical across 4+ different authors.

    Primary keyword-free signal for "copy real comment + append scam phrase" pattern.
    TAIL_MIN_AUTHORS=4 eliminates organic topical repeats (e.g. "no nfc is crazy"
    posted by 2-3 genuine viewers) while catching coordinated bot campaigns which
    consistently show 4-10+ accounts posting the same appended phrase.
    """
    tail_to_comments: Dict[str, List[CommentIn]] = defaultdict(list)
    for c in comments:
        if not c.text:
            continue
        tail = extract_tail(c.text)
        if tail:
            tail_to_comments[tail].append(c)

    log.info("Tail dedup | unique_tails=%d", len(tail_to_comments))
    flagged: set = set()
    unique_tails = list(tail_to_comments.items())

    # Pass 1: exact tail matches — require TAIL_MIN_AUTHORS distinct authors
    for tail, cs in unique_tails:
        if len({c.author for c in cs}) >= TAIL_MIN_AUTHORS:
            for c in cs:
                flagged.add(c.comment_id)
    log.info("Tail dedup | pass1_exact_flagged=%d", len(flagged))

    # Pass 2: fuzzy — 6-gram shingle pre-filter, capped at 1000 pairs
    tail_bucket: Dict[str, list] = defaultdict(list)
    for tail, cs in unique_tails:
        shingles = {tail[i:i+6] for i in range(max(0, len(tail) - 5))}
        for key in sorted(shingles)[:3]:
            tail_bucket[key].append((tail, cs))

    pairs: set = set()
    done = False
    for bucket_items in tail_bucket.values():
        if done or len(bucket_items) < 2:
            continue
        for i in range(len(bucket_items)):
            if done:
                break
            for j in range(i + 1, len(bucket_items)):
                ta, _ = bucket_items[i]
                tb, _ = bucket_items[j]
                if ta != tb:
                    pairs.add((min(ta, tb), max(ta, tb)))
                if len(pairs) >= 1000:
                    done = True
                    break

    log.info("Tail dedup | fuzzy_candidate_pairs=%d", len(pairs))
    tail_map = dict(unique_tails)
    for tail_a, tail_b in pairs:
        cs_a = tail_map.get(tail_a, [])
        cs_b = tail_map.get(tail_b, [])
        all_authors = {c.author for c in cs_a} | {c.author for c in cs_b}
        if len(all_authors) < TAIL_MIN_AUTHORS:
            continue
        if SequenceMatcher(None, tail_a, tail_b).ratio() >= TAIL_SIMILARITY:
            for c in cs_a:
                flagged.add(c.comment_id)
            for c in cs_b:
                flagged.add(c.comment_id)

    log.info("Tail dedup | total_flagged=%d", len(flagged))
    return flagged


def find_burst_accounts(comments: List[CommentIn], new_account_ids: set) -> set:
    """
    Find comment IDs that are part of a timing burst:
    3+ comments from NEW accounts posted within BURST_WINDOW_SECS of each other.
    """
    new_comments = [
        c for c in comments
        if c.author_channel_id in new_account_ids and c.publish_timestamp is not None
    ]
    new_comments.sort(key=lambda c: c.publish_timestamp)

    burst_ids: set = set()
    for i, anchor in enumerate(new_comments):
        window = [
            c for c in new_comments[i:]
            if c.publish_timestamp - anchor.publish_timestamp <= BURST_WINDOW_SECS * 1000
        ]
        if len(window) >= BURST_MIN_COUNT:
            for c in window:
                burst_ids.add(c.comment_id)

    return burst_ids


def find_incoherent_tail_ids(comments: List[CommentIn]) -> set:
    """
    Detect comments where the final sentence is semantically unrelated to the body.

    Uses a local sentence-transformer model to embed the body and tail separately,
    then computes cosine similarity. A legitimate comment has a tail that's
    topically related to the body (similarity > COHERENCE_THRESHOLD). A scam
    injection appended to a real comment will show a sharp semantic disconnect.

    Only runs when COHERENCE_AVAILABLE=True (sentence-transformers installed).
    Only checks comments with a long enough body to be meaningful.
    Batches all embeddings in a single model call for speed.
    """
    if not COHERENCE_AVAILABLE:
        return set()

    import numpy as np

    candidates = []
    for c in comments:
        if not c.text:
            continue
        tail = extract_tail(c.text)
        if not tail:
            continue
        # Split body = everything before the tail
        body = c.text.strip()
        tail_start = body.lower().rfind(tail)
        if tail_start > 0:
            body = body[:tail_start].strip()
        if len(body) < COHERENCE_BODY_MIN:
            continue
        candidates.append((c.comment_id, body, tail))

    if not candidates:
        return set()

    # Batch encode bodies and tails in one pass
    texts   = [body for _, body, _ in candidates] + [tail for _, _, tail in candidates]
    try:
        import torch
        vectors = COHERENCE_MODEL.encode(texts, batch_size=64, show_progress_bar=False,
                                         convert_to_tensor=True, normalize_embeddings=True)
        vectors = vectors.cpu().float()
        n        = len(candidates)
        bodies_v = vectors[:n]
        tails_v  = vectors[n:]
        # Cosine similarity = dot product of unit vectors
        sims = (bodies_v * tails_v).sum(dim=1).tolist()
    except Exception as ex:
        log.warning("Coherence encode failed: %s", ex)
        return set()
    flagged = set()

    for i, (comment_id, body, tail) in enumerate(candidates):
        if sims[i] < COHERENCE_THRESHOLD:
            flagged.add(comment_id)

    if flagged:
        log.info("Coherence signal: %d comments have semantically incoherent tails", len(flagged))

    return flagged


def infer_tactic(comment: CommentIn, signals: List[str]) -> str:
    """Infer the most likely scam tactic from triggered signals and comment text."""
    text = (comment.text or "").lower()
    if "explicit_profile_picture" in signals:
        return "SCAM_ADULT"
    if re.search(r'\b(crypto|bitcoin|ethereum|invest|wallet|airdrop|token|passive.income|trading.signal)\b', text, re.I):
        return "SCAM_CRYPTO"
    if re.search(r'\b(dm\s*me|whatsapp|telegram|onlyfans|link.in.bio)\b', text, re.I):
        return "SCAM_FUNNEL"
    if re.search(r'\b(lonely|widow|sugar.daddy|sugar.momm|looking.for.love)\b', text, re.I):
        return "SCAM_ROMANCE"
    if re.search(r'\b(congratulations|you.won|claim.your|free.gift|giveaway)\b', text, re.I):
        return "SCAM_GIVEAWAY"
    if "duplicate_tail_across_authors" in signals or "incoherent_tail" in signals:
        return "SCAM_CRYPTO"
    return "SCAM_BOT"

# ── main endpoint ─────────────────────────────────────────────────────────────
@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    t0       = time.time()
    comments = req.comments
    n        = len(comments)
    log.info("POST /analyze | comments=%d", n)

    if not comments:
        return []

    # ── 1. Fetch channel stats ────────────────────────────────────────────────
    channel_ids   = list({c.author_channel_id for c in comments if c.author_channel_id})
    channel_stats = await fetch_channel_stats(channel_ids)

    # ── 2. Classify account ages ──────────────────────────────────────────────
    new_account_ids:      set = set()
    very_new_account_ids: set = set()
    for cid, stats in channel_stats.items():
        age = account_age_days(stats.get("created_at"))
        if age is not None:
            if age < VERY_NEW_ACCOUNT_DAYS:
                very_new_account_ids.add(cid)
                new_account_ids.add(cid)
            elif age < NEW_ACCOUNT_DAYS:
                new_account_ids.add(cid)

    # ── 3. Full-text duplicate detection ─────────────────────────────────────
    dup_comment_ids = find_duplicate_groups(comments)

    # ── 4. Tail-sentence duplicate detection ─────────────────────────────────
    # Catches: "real comment body... [appended scam phrase]"
    # No brand names required — detects structural repetition.
    tail_dup_ids = find_tail_duplicate_ids(comments)

    # ── 5. Burst timing detection ─────────────────────────────────────────────
    burst_comment_ids = find_burst_accounts(comments, new_account_ids)

    # ── 6. Semantic coherence check ───────────────────────────────────────────
    # Catches one-off scam injections that didn't coordinate tails with other bots.
    # Low cosine similarity between body and tail = topic shift = likely injection.
    incoherent_ids = find_incoherent_tail_ids(comments)

    # ── 6. Profile picture analysis (only pre-suspicious accounts) ────────────
    pfp_tasks: Dict[str, Any] = {}
    if NUDENET_AVAILABLE:
        for c in comments:
            cid = c.author_channel_id
            is_already_suspicious = (
                cid in new_account_ids           or
                c.comment_id in dup_comment_ids  or
                c.comment_id in tail_dup_ids     or
                c.comment_id in burst_comment_ids or
                c.comment_id in incoherent_ids
            )
            if is_already_suspicious and c.author_profile_image_url:
                pfp_tasks[c.comment_id] = asyncio.create_task(
                    check_profile_picture(c.author_profile_image_url)
                )

    explicit_pfp_ids: set = set()
    if pfp_tasks:
        pfp_results = await asyncio.gather(*pfp_tasks.values(), return_exceptions=True)
        for comment_id, result in zip(pfp_tasks.keys(), pfp_results):
            if result is True:
                explicit_pfp_ids.add(comment_id)

    # ── 7. Build reply map for collusion detection ────────────────────────────
    id_to_channel = {c.comment_id: c.author_channel_id for c in comments}

    # ── 8. Score each comment ─────────────────────────────────────────────────
    results    = []
    scam_count = 0

    for c in comments:
        score   = 0
        signals = []
        cid     = c.author_channel_id
        stats   = channel_stats.get(cid, {}) if cid else {}
        age     = account_age_days(stats.get("created_at")) if stats else None

        # Account age
        if cid in very_new_account_ids:
            score += W_ACCOUNT_VERY_NEW
            signals.append("account_very_new_<30d")
        elif cid in new_account_ids:
            score += W_ACCOUNT_NEW
            signals.append("account_new_<90d")

        # Subscriber/video — gated on new account to avoid lurker false positives
        if stats and age is not None and age < NEW_ACCOUNT_DAYS:
            if stats.get("subscriber_count", -1) == 0:
                score += W_ZERO_SUBSCRIBERS
                signals.append("zero_subscribers")
            if stats.get("video_count", -1) == 0:
                score += W_ZERO_VIDEOS
                signals.append("zero_videos")

        # Zero likes + new account
        if c.like_count == 0 and cid in new_account_ids:
            score += W_ZERO_LIKES_NEW
            signals.append("zero_likes_new_account")

        # Full-text duplicate across different authors
        if c.comment_id in dup_comment_ids:
            score += W_DUPLICATE_TEXT
            signals.append("duplicate_text_across_authors")

        # Tail-sentence duplicate across different authors
        # Primary keyword-free signal for appended-scam-phrase pattern
        if c.comment_id in tail_dup_ids:
            score += W_DUPLICATE_TAIL
            signals.append("duplicate_tail_across_authors")

        # Semantic incoherence: tail is topically unrelated to comment body.
        # Catches one-off injections that didn't reuse tails across accounts.
        if c.comment_id in incoherent_ids:
            score += W_INCOHERENT_TAIL
            signals.append("incoherent_tail")

        # Burst timing from new accounts
        if c.comment_id in burst_comment_ids:
            score += W_BURST_TIMING
            signals.append("burst_timing_new_accounts")

        # Explicit profile picture
        if c.comment_id in explicit_pfp_ids:
            score += W_EXPLICIT_PFP
            signals.append("explicit_profile_picture")

        # Collusion: reply chain between two new accounts
        if c.parent_comment_id:
            parent_channel = id_to_channel.get(c.parent_comment_id)
            if parent_channel and parent_channel in new_account_ids and cid in new_account_ids:
                score += W_COLLUSION_REPLY
                signals.append("collusion_reply_between_new_accounts")

        is_scam = score >= SCAM_SCORE_THRESHOLD
        tactic  = infer_tactic(c, signals) if is_scam else None

        if is_scam:
            scam_count += 1

        results.append({
            "comment_id": c.comment_id,
            "label":      "SCAM" if is_scam else "HAM",
            "score":      round(score / MAX_SCORE, 4),  # normalised 0.0–1.0
            "tactic":     tactic,
            "signals":    signals,
        })

    dt = time.time() - t0
    log.info("Done | comments=%d | flagged=%d | seconds=%.2f", n, scam_count, dt)
    return results


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))