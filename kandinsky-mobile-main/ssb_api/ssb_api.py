# import torch
# from fastapi import FastAPI
# from fastapi.middleware.cors import CORSMiddleware
# from pydantic import BaseModel
# from typing import List
# from transformers import pipeline

# app = FastAPI()

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["*"],
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

# # Load the BERT model you just installed
# print("Initializing BERT-Tiny AI...")
# classifier = pipeline("text-classification", model="mrm8488/bert-tiny-finetuned-sms-spam-detection")

# class CommentRequest(BaseModel):
#     comments: List[str]

# @app.post("/analyze")
# async def analyze(request: CommentRequest):
#     # Process comments through the AI
#     predictions = classifier([c[:512] for c in request.comments])
    
#     results = []
#     for pred in predictions:
#         # BERT-Tiny uses 'label_1' for spam and 'label_0' for ham
#         is_spam = pred['label'].lower() == 'label_1'
#         score = pred['score'] if is_spam else (1 - pred['score'])
        
#         results.append({
#             "label": "SCAM" if is_spam else "HAM",
#             "score": score
#         })
    
#     print(f"AI Analysis Complete: Found {sum(1 for r in results if r['label'] == 'SCAM')} potential scams.")
#     return results

# if __name__ == "__main__":
#     import uvicorn
#     uvicorn.run(app, host="0.0.0.0", port=8000)

import os
import re
import time
import logging
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

# -------------------------
# Config
# -------------------------
# DATA_PATH = os.getenv("SSB_DATA_PATH", "data/labeled_comments.tsv")
# MODEL_DIR = os.getenv("SSB_MODEL_DIR", "models")
# MODEL_PATH = os.path.join(MODEL_DIR, "ssb_tfidf_lr.joblib")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DATA_PATH = os.getenv("SSB_DATA_PATH", os.path.join(BASE_DIR, "data", "labeled_comments.tsv"))
MODEL_DIR = os.getenv("SSB_MODEL_DIR", os.path.join(BASE_DIR, "models"))
MODEL_PATH = os.path.join(MODEL_DIR, "ssb_tfidf_lr.joblib")

# Rule thresholds
RULE_HARD_SCAM_SCORE = 6     # >= this => SCAM immediately
RULE_SOFT_SCAM_SCORE = 3     # >= this and ML agrees => SCAM

# -------------------------
# Logging
# -------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)
log = logging.getLogger("ssb")

# -------------------------
# Rules (cheap, high-signal)
# -------------------------
TICKER_RE = re.compile(r"\$[A-Za-z0-9]{3,10}")
URL_RE = re.compile(r"(https?://|www\.)\S+", re.IGNORECASE)
HANDLE_RE = re.compile(r"@[\w\d_]{3,}", re.IGNORECASE)

KEYWORDS_ADULT = re.compile(r"\b(naughty|onlyfans|sex|snapchat|snap)\b", re.IGNORECASE)
KEYWORDS_FUNNEL = re.compile(
    r"\b(dm me|inbox|message me|contact|reach me|telegram|whatsapp|t\.me|link in bio|check my bio|profile picture)\b",
    re.IGNORECASE
)
KEYWORDS_PROFIT = re.compile(
    r"\b(profit|earned|returns|roi|win rate|money printer|bull run|airdrop|mining|signals|vip group|copy trading|forex|binary options|withdraw instantly)\b",
    re.IGNORECASE
)

HEART_SPAM_RE = re.compile(r"(❤️|😍|💖|💸|🚀|🌕|🙏|👼|💅|💎){3,}")

def rule_features(text: str) -> Dict[str, Any]:
    t = (text or "").strip()
    score = 0
    tags = []

    if URL_RE.search(t):
        score += 4; tags.append("url")
    if KEYWORDS_FUNNEL.search(t):
        score += 4; tags.append("funnel")
    if KEYWORDS_ADULT.search(t):
        score += 6; tags.append("adult")
    if TICKER_RE.search(t):
        score += 4; tags.append("ticker")
    if KEYWORDS_PROFIT.search(t):
        score += 3; tags.append("profit")
    if HANDLE_RE.search(t):
        score += 2; tags.append("handle")
    if HEART_SPAM_RE.search(t):
        score += 1; tags.append("emoji_spam")

    # very short generic messages are often spam, but keep weight low (avoid flagging "First" too aggressively)
    if len(t) <= 10:
        score += 0  # keep as 0 to reduce false positives on "First", "Hi", etc.

    return {"rule_score": score, "rule_tags": tags}

def tactic_from_tags(tags: List[str]) -> Optional[str]:
    if "adult" in tags:
        return "SCAM_ADULT"
    if "ticker" in tags and "profit" in tags:
        return "SCAM_CRYPTO"
    if "funnel" in tags and ("profit" in tags or "handle" in tags or "url" in tags):
        return "SCAM_FUNNEL"
    if "url" in tags and "profit" in tags:
        return "SCAM_FUNNEL"
    if "emoji_spam" in tags and "funnel" in tags:
        return "SCAM_FUNNEL"
    return None

# -------------------------
# ML model (TF-IDF + Logistic Regression)
# -------------------------
def build_pipeline() -> Pipeline:
    # Word + char ngrams works well on spam/scam text and emoji-ish patterns
    vectorizer = TfidfVectorizer(
        lowercase=True,
        strip_accents="unicode",
        ngram_range=(1, 2),
        max_features=200_000,
        min_df=2
    )
    clf = LogisticRegression(
        max_iter=200,
        class_weight="balanced",  # helps if your dataset is skewed
        solver="liblinear"
    )
    return Pipeline([("tfidf", vectorizer), ("clf", clf)])

def load_labeled_tsv(path: str) -> Dict[str, List[str]]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"Dataset not found: {path}")

    texts, labels = [], []
    with open(path, "r", encoding="utf-8") as f:
        header = f.readline().rstrip("\n")
        if "text" not in header or "label" not in header:
            raise ValueError("TSV header must include: text<TAB>label")

        for line_no, line in enumerate(f, start=2):
            line = line.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            text = "\t".join(parts[:-1]).strip()
            label = parts[-1].strip().upper()
            if label not in ("SCAM", "HAM"):
                continue
            texts.append(text)
            labels.append(label)

    return {"texts": texts, "labels": labels}

def train_and_save_model(data_path: str, model_path: str) -> Dict[str, Any]:
    t0 = time.time()
    data = load_labeled_tsv(data_path)
    X, y = data["texts"], data["labels"]

    if len(X) < 20:
        raise ValueError(f"Too few training rows: {len(X)} (need at least ~20)")

    os.makedirs(os.path.dirname(model_path), exist_ok=True)

    log.info(f"Training ML model on {len(X)} rows...")
    pipeline = build_pipeline()

    # simple progress log (fit has no callback)
    log.info("Vectorizing + fitting (this should be fast on CPU)...")
    pipeline.fit(X, y)

    joblib.dump(pipeline, model_path)
    dt = time.time() - t0

    # quick sanity: counts
    scam_count = sum(1 for lbl in y if lbl == "SCAM")
    ham_count = sum(1 for lbl in y if lbl == "HAM")

    log.info(f"Saved model to {model_path} in {dt:.2f}s | SCAM={scam_count}, HAM={ham_count}")
    return {"rows": len(X), "scam": scam_count, "ham": ham_count, "seconds": dt, "model_path": model_path}

# -------------------------
# FastAPI
# -------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class CommentRequest(BaseModel):
    comments: List[str]

MODEL: Optional[Pipeline] = None

@app.on_event("startup")
def startup_event():
    global MODEL
    if os.path.exists(MODEL_PATH):
        log.info(f"Loading model from {MODEL_PATH} ...")
        MODEL = joblib.load(MODEL_PATH)
        log.info("Model loaded.")
    else:
        log.warning(f"No model found at {MODEL_PATH}. Call POST /train to train first.")

@app.get("/health")
def health():
    return {"ok": True, "model_loaded": MODEL is not None, "model_path": MODEL_PATH, "data_path": DATA_PATH}

@app.post("/train")
def train():
    try:
        info = train_and_save_model(DATA_PATH, MODEL_PATH)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    # load it immediately after training
    global MODEL
    MODEL = joblib.load(MODEL_PATH)
    return {"status": "trained", **info}

@app.post("/analyze")
def analyze(req: CommentRequest):
    if not req.comments:
        return []

    if MODEL is None:
        raise HTTPException(status_code=400, detail="Model not trained/loaded. Call POST /train first.")

    t0 = time.time()
    comments = [c or "" for c in req.comments]

    # ML probabilities
    # LogisticRegression gives decision_function; sklearn pipeline exposes predict_proba
    probs = MODEL.predict_proba(comments)
    # class order corresponds to MODEL.named_steps["clf"].classes_
    classes = list(MODEL.named_steps["clf"].classes_)
    scam_idx = classes.index("SCAM")

    results = []
    scam_count = 0

    for i, text in enumerate(comments):
        rf = rule_features(text)
        rscore = rf["rule_score"]
        tags = rf["rule_tags"]
        tactic = tactic_from_tags(tags)

        ml_scam_prob = float(probs[i][scam_idx])

        # Decision: rules dominate, ML supports borderline
        # scam_prob is ALWAYS "probability this is a scam"
        scam_prob = min(1.0, ml_scam_prob + (0.05 * rscore))

        # Rules dominate; ML supports borderline
        is_scam = False
        if rscore >= RULE_HARD_SCAM_SCORE:
            is_scam = True
        elif rscore >= RULE_SOFT_SCAM_SCORE and scam_prob >= 0.55:
            is_scam = True
        elif ml_scam_prob >= 0.70:
            is_scam = True

        label = "SCAM" if is_scam else "HAM"

        # Optional: keep tactic info separately (not as label)
        tactic = tactic_from_tags(tags) if is_scam else None

        score = scam_prob


        if label != "HAM":
            scam_count += 1

        results.append({
            "label": label,       # strictly SCAM / HAM
            "score": score,       # strictly scam probability
            "tactic": tactic,     # optional extra detail
            "debug": {
                "rule_score": rscore,
                "rule_tags": tags,
                "ml_scam_prob": ml_scam_prob
            }
        })


        # progress log every 200 comments
        if (i + 1) % 200 == 0:
            log.info(f"Analyzed {i+1}/{len(comments)} comments...")

    dt = time.time() - t0
    log.info(f"Analyze done: {len(comments)} comments in {dt:.2f}s | flagged={scam_count}")
    return results
