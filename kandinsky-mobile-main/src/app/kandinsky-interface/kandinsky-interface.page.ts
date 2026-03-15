// kandinsky-interface.page.ts
import { Component, OnInit, ViewChild, ElementRef } from '@angular/core';
import { CanvasComponent, ConcentricCircle, Circle } from './canvas/canvas.component';
import { SocialComment, SocialPlatform, SocialPost } from '../models/models';
import { ModalController, IonSearchbar, LoadingController, NavController } from '@ionic/angular';
import { TimelineControlsComponent } from './timeline-controls/timeline-controls.component';
import { PostInformationModalComponent } from './post-information-modal/post-information-modal.component';
import { KandinskyService, SearchResult, CommentGroupInterval } from '../services/kandinsky.service';
import { ScamBotService } from '../services/social/scam-bot.service';
import _ from 'lodash';
import * as d3 from 'd3';
import { SpectrumRange, SpectrumInterval } from './spectrum-controls/spectrum-controls.component';
import { HighlightOption } from '../highlight.pipe';
import { ActivatedRoute } from '@angular/router';
import {
  MIN_PROGRESS, MIN_TIMESTAMP, SPECTRUM_DEFAULT_MODE,
  SEARCH_DEFAULT_MODE, SEARCH_DEFAULT_QUERY, SHOW_COMMENTS_DEFAULT,
  MAX_LIKE_BAR_WIDTH_PX, MIN_LIKE_BAR_WIDTH_PX, SHOW_SIMILARITY_DEFAULT,
  MINIMIZE_REFERENCE_COMMENT, NUM_GROUPS
} from 'src/app/config';
import { buildLinearScale, createLoading, isConcentricCircleDatum, scrollToElement } from '../utils';
import { ScamResultFull } from './scam-canvas/scam-canvas.component';

export type ActiveTab = 'visualisation' | 'scam';

// Search highlight colours (matching the original page's convention)
const SEARCH_HIGHLIGHT_COLOR   = 'yellow';
const SEARCH_HIGHLIGHT_TEXT    = 'black';

@Component({
  selector: 'ksky-kandinsky-interface',
  templateUrl: './kandinsky-interface.page.html',
  styleUrls: ['./kandinsky-interface.page.scss'],
})
export class KandinskyInterfacePage implements OnInit {

  // ── tab state ─────────────────────────────────────────────────────────────
  activeTab: ActiveTab = 'visualisation';

  // ── Scam analysis state ───────────────────────────────────────────────────
  scamResultsMap = new Map<string, ScamResultFull>();
  scamThreshold  = 85;   // 0-100 scale (API returns raw score 0-200+)
  scamStats: ScamStats | null = null;
  scamCommentIds: string[] = [];
  scamNodeCount = 0;       // live count from scam-canvas (source of truth for display)
  allComments: SocialComment[] = [];
  scamAnalysisComplete = false;   // gates the tab — becomes true once first run finishes
  scamAnalysisFailed   = false;   // allows retry UI

  // Internal scam fields (kept for CSV export / insights modal)
  private lastScamResults: ScamResultFull[] = [];

  // ── Category filter (moved from modal to main view) ───────────────────────
  availableTactics: string[] = [];
  activeTacticFilters: string[] = [];   // empty = all shown

  // ── post data ─────────────────────────────────────────────────────────────
  protected post: SocialPost;

  // ── canvas params ─────────────────────────────────────────────────────────
  protected timestamp: number = MIN_TIMESTAMP;

  // ── timeline controls params ──────────────────────────────────────────────
  protected progress: number = MIN_PROGRESS;
  protected maxProgress: number;

  // ── spectrum controls params ──────────────────────────────────────────────
  protected isSpectrumModeOn: boolean = SPECTRUM_DEFAULT_MODE;
  protected spectrumIntervals: SpectrumInterval[];
  protected spectrumRange: SpectrumRange;
  protected spectrumStartTime: number;
  protected spectrumEndTime: number;
  private NUM_GROUPS: number = NUM_GROUPS;

  // ── search params ─────────────────────────────────────────────────────────
  protected isSearchFocusModeOn: boolean = SEARCH_DEFAULT_MODE;
  protected searchQuery: string = SEARCH_DEFAULT_QUERY;
  private searchResult: SearchResult;
  protected searchResultIds: string[] = [];
  protected currentSearchIndex: number = -1;

  // ── detailed comment section ──────────────────────────────────────────────
  protected isShowCommentsOn: boolean = SHOW_COMMENTS_DEFAULT;
  protected selectedConcentricCircle: ConcentricCircle;
  protected visibleCommentsCount: number;
  private barWidthScale: d3.ScaleLinear<number, number>;
  private groupedCommentsByTimestamp: CommentGroupInterval[];
  protected readonly MAX_LIKE_BAR_WIDTH: number = MAX_LIKE_BAR_WIDTH_PX;
  private readonly MIN_LIKE_BAR_WIDTH: number = MIN_LIKE_BAR_WIDTH_PX;

  // ── similar comments section ──────────────────────────────────────────────
  protected isShowSimilarCommentsOn: boolean = SHOW_SIMILARITY_DEFAULT;
  protected isReferenceCommentMinimized: boolean = MINIMIZE_REFERENCE_COMMENT;
  protected visibleSimilarCommentsCount: number;

  // ── comment item contexts ─────────────────────────────────────────────────
  protected commentContext: CommentItemContext;
  protected commentRepliesContexts: CommentItemContext[];
  protected referenceCommentContext: CommentItemContext;
  protected similarCommentsContexts: CommentItemContext[];

  // misc
  protected fullTitle = false;
  protected isFocusModeOn = false;
  protected scamLoading = false;

  @ViewChild('timelineControls', { static: false }) timelineControls: TimelineControlsComponent;
  @ViewChild('canvas', { static: true }) canvas: CanvasComponent;
  @ViewChild('commentsList', { static: false, read: ElementRef }) commentsList: ElementRef;
  @ViewChild('searchbar', { static: false }) searchbar: IonSearchbar;

  postInformationModal: HTMLIonModalElement;

  constructor(
    private kandinskyService: KandinskyService,
    private modalController: ModalController,
    private loadingController: LoadingController,
    private route: ActivatedRoute,
    private navController: NavController,
    private scamBotService: ScamBotService
  ) {}

  ngOnInit() {
    this.route.params.subscribe(params => {
      this.initialize(params.id, params.platform);
    });
  }

  // ── tab switching ─────────────────────────────────────────────────────────
  switchTab(tab: ActiveTab) {
    // Guard: scam tab only navigable once analysis is complete
    if (tab === 'scam' && !this.scamAnalysisComplete) return;
    this.activeTab = tab;
    // Reset canvas zoom when returning to visualisation tab
    if (tab === 'visualisation') {
      setTimeout(() => this.canvas && this.canvas.resetZoom(), 50);
    }
  }

  // ── Category filter toggle (called from main view pill buttons) ───────────
  toggleTacticFilter(tactic: string) {
    const idx = this.activeTacticFilters.indexOf(tactic);
    if (idx === -1) {
      this.activeTacticFilters = [...this.activeTacticFilters, tactic];
    } else {
      this.activeTacticFilters = this.activeTacticFilters.filter(t => t !== tactic);
    }
  }

  isTacticFilterActive(tactic: string): boolean {
    return this.activeTacticFilters.includes(tactic);
  }

  clearTacticFilters() {
    this.activeTacticFilters = [];
  }

  // ── Scam canvas count output ──────────────────────────────────────────────
  onScamCountChanged(count: number) {
    this.scamNodeCount = count;
  }

  // ── Scam analysis — called automatically from initialiseComponents ─────────
  async runScamAnalysis(): Promise<void> {
    this.scamAnalysisFailed = false;

    return new Promise<void>((resolve, reject) => {
      this.scamBotService.analyzeComments(this.allComments).subscribe({
        next: (results: any[]) => {
          this.lastScamResults = results;

          this.scamResultsMap = new Map(
            results.map((r, i) => {
              const c = this.allComments[i];
              return c ? [c.id, r as ScamResultFull] : null;
            }).filter(Boolean) as [string, ScamResultFull][]
          );

          this.scamStats = this.buildScamStats(this.allComments, results, this.scamThreshold);
          this.scamCommentIds = this.scamStats.reviewQueue.map(r => r.commentId);

          // Populate available tactics for the category filter pills
          this.availableTactics = Object.keys(this.scamStats.byTactic);

          this.scamAnalysisComplete = true;
          resolve();
        },
        error: (err) => {
          console.error('Scam analyze failed', err);
          this.scamAnalysisFailed = true;
          reject(err);
        }
      });
    });
  }

  // ── Retry after failure ───────────────────────────────────────────────────
  async retryScamAnalysis(): Promise<void> {
    this.scamLoading = true;
    try {
      await this.runScamAnalysis();
    } catch { /* already flagged in runScamAnalysis */ }
    finally { this.scamLoading = false; }
  }

  // ── called by Scam canvas when user clicks a node ────────────────────────
  onScamNodeSelected(data: { comment: SocialComment; result: ScamResultFull } | null) {
    // Nothing needed at page level currently — detail panel is inside scam-canvas
  }

  // ── retrieve operator ─────────────────────────────────────────────────────
  private retrieve(groupOfCircles: ConcentricCircle | Circle[]): void {
    if (isConcentricCircleDatum(groupOfCircles)) {
      const circles = this.canvas.getConcentricCircleCircles(groupOfCircles);
      this.commentContext = this.buildCommentItemContext(circles[0]);
      this.commentRepliesContexts = circles.slice(1).map(c => this.buildCommentItemContext(c));
    } else {
      this.referenceCommentContext = this.buildCommentItemContext(groupOfCircles[0], {
        showRepliesButton: false, showSimilaritiesButton: false,
        showLines: false, forceVisibility: true
      });
      this.similarCommentsContexts = groupOfCircles.slice(1).map(circle =>
        this.buildCommentItemContext(circle, {
          showRepliesButton: false, showSimilaritiesButton: false, showSimilarityScore: true
        })
      );
    }
  }

  // ── initialise ────────────────────────────────────────────────────────────
  private async initialize(postId: string, platform: SocialPlatform): Promise<void> {
    this.barWidthScale = d3.scaleLinear().range([this.MIN_LIKE_BAR_WIDTH, this.MAX_LIKE_BAR_WIDTH]);
    const loading = await createLoading(this.loadingController);
    loading.present();
    await this.kandinskyService.setActivePost(postId, platform, loading);
    await this.initialiseComponents();
  }

  private async initialiseComponents(): Promise<void> {
    this.post = this.kandinskyService.getActivePost();
    this.maxProgress = this.post.commentCount - 1;
    this.allComments = this.kandinskyService.getActivePostComments();

    // ── Fire Scam analysis in background — do NOT await ───────────────────
    this.scamLoading = true;
    this.runScamAnalysis()
      .catch(err => console.warn('Scam background run failed:', err))
      .finally(() => { this.scamLoading = false; });
    // ─────────────────────────────────────────────────────────────────────

    await this.createPostInformationModal();
    this.groupedCommentsByTimestamp = this.kandinskyService.groupCommentsByTimestamp(this.NUM_GROUPS);
    this.spectrumIntervals = this.groupedCommentsByTimestamp.map(g => ({ heightValue: g.comments.length }));
    this.canvas.constructCanvas(this.allComments);
  }

  protected onCanvasReady(): void {
    this.loadingController.dismiss();
  }

  // ── post information modal ────────────────────────────────────────────────
  private async createPostInformationModal(): Promise<void> {
    this.postInformationModal = await this.modalController.create({
      component: PostInformationModalComponent,
      componentProps: {
        post: this.post,
        reloadDataHandler: this.reloadDataHandler.bind(this),
        deletePostHandler: this.deletePostHandler.bind(this),
        dismissPostInformation: this.dismissPostInformation.bind(this)
      },
      cssClass: 'auto-sized-modal'
    });
  }

  protected async displayPostInformation(): Promise<void> {
    await this.postInformationModal.present();
    this.postInformationModal.onDidDismiss().then(async () => await this.createPostInformationModal());
  }

  private async reloadDataHandler(): Promise<void> {
    const loading = await createLoading(this.loadingController);
    loading.present();
    await this.kandinskyService.reloadActivePost(loading);
    await this.initialiseComponents();
    this.timelineControls.reset();
  }

  private async deletePostHandler(): Promise<void> {
    const loading = await createLoading(this.loadingController);
    await loading.present();
    await this.kandinskyService.deletePost(this.post.id, this.post.platform, loading);
    await loading.dismiss();
    this.navController.navigateBack(['']);
  }

  protected async dismissPostInformation(): Promise<void> {
    this.postInformationModal.dismiss();
  }

  // ── canvas events ─────────────────────────────────────────────────────────
  protected selectConcentricCircle(pivotId?: string, targetCircleId?: string): void {
    this.canvas.selectByPivotId(pivotId);
    if (pivotId && targetCircleId) scrollToElement(`comment-${targetCircleId}`);
  }

  protected selectedConcentricCircleChange(concentricCircleDatum: ConcentricCircle = null): void {
    if (this.isShowSimilarCommentsOn) this.selectedSimilarityReferenceCircleChange();
    if (this.timelineControls) this.timelineControls.pause();
    if (this.selectedConcentricCircle === concentricCircleDatum) return;
    this.updateDetailedCommentSectionProps(concentricCircleDatum);
    if (this.commentsList) this.commentsList.nativeElement.scrollTop = 0;
  }

  protected selectedSimilarityReferenceCircleChange(circleDatum: Circle = null): void {
    if (circleDatum) this.searchQuery = '';
    this.updateSimilarityCommentsProps(circleDatum);
  }

  private updateDetailedCommentSectionProps(concentricCircleDatum: ConcentricCircle): void {
    this.selectedConcentricCircle = concentricCircleDatum;
    this.isShowCommentsOn = !!concentricCircleDatum;
    this.visibleCommentsCount = concentricCircleDatum
      ? this.canvas.countDisplayedCircles(concentricCircleDatum) : 0;
    if (!concentricCircleDatum) {
      this.commentContext = null;
      this.commentRepliesContexts = [];
    } else {
      this.retrieve(concentricCircleDatum);
    }
  }

  private updateSimilarityCommentsProps(referenceCircleDatum?: Circle): void {
    if (!referenceCircleDatum) {
      this.isShowSimilarCommentsOn = false;
      this.visibleSimilarCommentsCount = 0;
      this.canvas.setFocused([]);
      return;
    }
    const referenceComment = this.kandinskyService.getComment(referenceCircleDatum.index);
    const similarCommentScores = this.kandinskyService.getSimilarCommentScores(referenceComment);
    const similarCommentIds = Object.keys(similarCommentScores);
    const similarCommentCircles = this.canvas.getCircleData(similarCommentIds);
    this.barWidthScale = this.buildLikeCountBarWidthScale(referenceCircleDatum, ...similarCommentCircles);
    this.canvas.setFocused(similarCommentIds);
    this.isShowSimilarCommentsOn = true;
    this.retrieve([referenceCircleDatum, ...similarCommentCircles]);
    this.similarCommentsContexts.forEach(ctx =>
      ctx.context.analytics.similarity.score = similarCommentScores[ctx.context.comment.id]
    );
    this.visibleSimilarCommentsCount = this.canvas.countDisplayedCircles(similarCommentCircles);
  }

  // ── timeline controls ─────────────────────────────────────────────────────
  // `timestamp` is an @Input on CanvasComponent — Angular propagates it
  // automatically when we assign this.timestamp, so no setTimestamp() call needed.
  protected timestampChange(progress: number): void {
    setTimeout(() => {
      this.updateCommentContexts();
      if (this.selectedConcentricCircle && !this.selectedConcentricCircle.isDisplayed) {
        this.canvas.selectByPivotId(null);
      }
    });
    this.timestamp = progress !== -1
      ? this.kandinskyService.getCommentTimestamp(progress)
      : 0;
  }

  // ── spectrum controls ─────────────────────────────────────────────────────
  protected toggleSpectrumMode(): void {
    this.isSpectrumModeOn = !this.isSpectrumModeOn;
    this.canvas.resetZoom();
    if (this.isSpectrumModeOn) {
      this.timestampChange(this.maxProgress);
    } else {
      this.canvas.setHighlighted([]);
    }
  }

  protected spectrumRangeChange(): void {
    const lowerIdx = this.spectrumRange.lower === -1 ? 0 : this.spectrumRange.lower;
    const upperIdx = this.spectrumRange.upper === -1 ? 0 : this.spectrumRange.upper;
    this.spectrumStartTime = this.groupedCommentsByTimestamp[lowerIdx].startTimestamp;
    this.spectrumEndTime   = this.groupedCommentsByTimestamp[upperIdx].endTimestamp;
    let commentIds: string[] = [];
    for (let i = lowerIdx; i <= upperIdx; i++) {
      commentIds.push(...this.groupedCommentsByTimestamp[i].comments.map(c => c.id));
    }
    this.canvas.setHighlighted(commentIds);
    setTimeout(() => this.updateCommentContexts());
  }

  // ── search ────────────────────────────────────────────────────────────────
  protected search(query: string = ''): void {
    this.isSearchFocusModeOn = query.length > 0;
    // Use the correct service method name: searchComments
    this.searchResult = this.kandinskyService.searchComments(query);
    this.canvas.setFocused(Object.keys(this.searchResult));

    // Update highlight options on already-visible comment contexts
    const commentContextsToUpdate: CommentItemContext[] = [];
    if (this.isShowCommentsOn) {
      commentContextsToUpdate.push(this.commentContext, ...this.commentRepliesContexts);
    }
    if (this.isShowSimilarCommentsOn) {
      commentContextsToUpdate.push(this.referenceCommentContext, ...this.similarCommentsContexts);
    }

    commentContextsToUpdate.filter(c => c && c.context.display.visible).forEach(c => {
      const match = this.searchResult[c.context.comment.id];
      // HighlightOption shape: { indices, color, textColor } — no 'query' field
      c.context.display.highlightOptions = match
        ? [{ indices: match, color: SEARCH_HIGHLIGHT_COLOR, textColor: SEARCH_HIGHLIGHT_TEXT }]
        : [];
    });

    this.searchResultIds = this.kandinskyService.getActivePostComments()
      .filter(c => this.searchResult[c.id] !== undefined)
      .map(c => c.id);
    this.currentSearchIndex = -1;
  }

  protected setIsSearchFocusOn(focused: boolean): void {
    this.isSearchFocusModeOn = focused;
    if (focused && this.timelineControls) this.timelineControls.pause();
  }

  protected goToPrevMatch(): void {
    if (!this.searchResultIds.length) return;
    this.currentSearchIndex = this.currentSearchIndex <= 0
      ? this.searchResultIds.length - 1
      : this.currentSearchIndex - 1;
    this.goToSearchResult(this.searchResultIds[this.currentSearchIndex]);
  }

  protected goToNextMatch(): void {
    if (!this.searchResultIds.length) return;
    this.currentSearchIndex = this.currentSearchIndex >= this.searchResultIds.length - 1
      ? 0
      : this.currentSearchIndex + 1;
    this.goToSearchResult(this.searchResultIds[this.currentSearchIndex]);
  }

  // Navigate to a search result using the canvas's existing selectByPivotId API
  private goToSearchResult(commentId: string): void {
    const comments = this.kandinskyService.getActivePostComments();
    const target = comments.find(c => c.id === commentId);
    if (!target) return;
    // Walk up to find the root pivot (top-level comment)
    let pivotId = target.id;
    let parentId = target.parentCommentId;
    while (parentId) {
      const parent = comments.find(c => c.id === parentId);
      if (!parent) break;
      pivotId = parent.id;
      parentId = parent.parentCommentId;
    }
    this.selectConcentricCircle(pivotId, commentId);
  }

  // ── Scam insights modal ───────────────────────────────────────────────────
  async openScamInsights(): Promise<void> {
    if (!this.scamStats) return;
    const modal = await this.modalController.create({
      component: (await import('../scam-insights-modal/scam-insights-modal.component')).ScamInsightsModalComponent as any,
      componentProps: {
        stats: this.scamStats,
        threshold: this.scamThreshold,
        onThresholdChange: (t: number) => {
          this.scamThreshold = t;
          this.scamStats = this.buildScamStats(this.allComments, this.lastScamResults, t);
          this.scamCommentIds = this.scamStats.reviewQueue.map(r => r.commentId);
          this.availableTactics = Object.keys(this.scamStats.byTactic);
          // Re-trigger scam canvas to rebuild with new threshold
          this.scamResultsMap = new Map(this.scamResultsMap);
        },
        onExportCSV: () => this.downloadScamCSV()
      },
      cssClass: 'auto-sized-modal'
    });
    await modal.present();
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  downloadScamCSV(): void {
    if (!this.lastScamResults.length) return;

    const header = ['comment_id','author','publish_timestamp','score','tactic','label','text'];
    const rows = [header.join(',')];
    const n = Math.min(this.allComments.length, this.lastScamResults.length);

    for (let i = 0; i < n; i++) {
      const c = this.allComments[i];
      const r = this.lastScamResults[i];
      if (!r || r.label !== 'SCAM') continue;
      const score = Number(r.score);
      if (isNaN(score) || score < this.scamThreshold) continue;
      rows.push([
        this.csvEsc(c.id), this.csvEsc(c.authorName),
        this.csvEsc(String(c.publishTimestamp)), this.csvEsc(String(score)),
        this.csvEsc(r.tactic || ''), this.csvEsc(r.label),
        this.csvEsc(c.content)
      ].join(','));
    }

    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scam_comments_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  private csvEsc(v: any): string {
    const s = v == null ? '' : String(v);
    return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ── Scam stats builder ────────────────────────────────────────────────────
  private buildScamStats(comments: SocialComment[], results: any[], threshold: number): ScamStats {
    const total = comments.length;
    let flagged = 0;
    const byTactic: Record<string, number> = {};
    const byRuleTag: Record<string, number> = {};
    const bins: ScamHistogramBin[] = Array.from({ length: 10 }, (_, b) => ({
      start: b / 10, end: (b + 1) / 10, count: 0
    }));
    const reviewQueue: ScamReviewRow[] = [];
    const n = Math.min(comments.length, results.length);

    for (let i = 0; i < n; i++) {
      const c = comments[i], r = results[i];
      if (!c || !r) continue;
      const score = Number(r.score);
      if (!isNaN(score)) bins[Math.min(9, Math.floor((score / 200) * 10))].count++;
      const isScam = r.label === 'SCAM' && score >= threshold;
      if (!isScam) continue;
      flagged++;
      const tactic = r.tactic || 'SCAM_BOT';
      byTactic[tactic] = (byTactic[tactic] || 0) + 1;
      (r.debug && r.debug.rule_tags || []).forEach((tag: string) => {
        byRuleTag[tag] = (byRuleTag[tag] || 0) + 1;
      });
      reviewQueue.push({
        commentId: c.id, author: c.authorName,
        publishTimestamp: c.publishTimestamp, score,
        tactic, label: r.label,
        preview: (c.content || '').slice(0, 160)
      });
    }

    reviewQueue.sort((a, b) => b.score - a.score);
    return { total, flagged, threshold, byTactic, byRuleTag, scoreHistogram: bins, reviewQueue };
  }

  // ── comment context builders ──────────────────────────────────────────────
  private buildCommentItemContext(circleDatum: Circle, {
    showRepliesButton = true, showSimilaritiesButton = true,
    showLines = true, forceVisibility = false,
    showSimilarityScore = false, similarityScore = 0
  } = {}): CommentItemContext {

    const comment = this.kandinskyService.getComment(circleDatum.index);
    // Look up any active search highlight for this comment
    const matchIndices = this.searchResult ? this.searchResult[comment.id] : null;
    const totalReplyCount = comment.commentCount > 0
      ? comment.commentCount
      : comment.comments ? comment.comments.length : 0;

    // Build HighlightOption correctly: { indices, color, textColor }
    const highlightOptions: HighlightOption[] = matchIndices
      ? [{ indices: matchIndices, color: SEARCH_HIGHLIGHT_COLOR, textColor: SEARCH_HIGHLIGHT_TEXT }]
      : [];

    return {
      context: {
        id: circleDatum.id,
        comment,
        display: {
          visible: forceVisibility || circleDatum.isDisplayed,
          showLines,
          highlightOptions
        },
        bar: {
          color: circleDatum.color,
          width: this.barWidthScale
            ? this.barWidthScale(comment.likeCount) + 'px'
            : this.MIN_LIKE_BAR_WIDTH + 'px'
        },
        circle: circleDatum,
        replies: {
          count: totalReplyCount,
          showViewAsReplyToParentButton: showRepliesButton && !!comment.parentCommentId,
          showViewRepliesButton: showRepliesButton && totalReplyCount > 0
        },
        analytics: {
          similarity: {
            showButton: showSimilaritiesButton,
            similarCommentsCount: 0,
            showScore: showSimilarityScore,
            score: similarityScore
          }
        }
      }
    };
  }

  private updateCommentContexts(): void {
    if (this.isShowSimilarCommentsOn) return;
    if (!this.selectedConcentricCircle) return;
    const circles = this.canvas.getConcentricCircleCircles(this.selectedConcentricCircle);
    this.visibleCommentsCount = this.canvas.countDisplayedCircles(this.selectedConcentricCircle);
    this.commentContext = this.buildCommentItemContext(circles[0]);
    this.commentRepliesContexts = circles.slice(1).map(c => this.buildCommentItemContext(c));
  }

  private buildLikeCountBarWidthScale(...circles: (ConcentricCircle | Circle)[]): d3.ScaleLinear<number, number> {
    let likeCounts = [];
    for (const circle of circles) {
      likeCounts = [...likeCounts, ...this.canvas.getLikeCounts(circle as any)];
    }
    const domain = d3.extent(likeCounts);
    return buildLinearScale(domain[0], domain[1], this.MIN_LIKE_BAR_WIDTH, this.MAX_LIKE_BAR_WIDTH);
  }
}

// ── local types ───────────────────────────────────────────────────────────────
type ScamReviewRow    = { commentId: string; author: string; publishTimestamp: number; score: number; tactic: string; label: string; preview: string };
type ScamHistogramBin = { start: number; end: number; count: number };
type ScamStats = { total: number; flagged: number; threshold: number; byTactic: Record<string,number>; byRuleTag: Record<string,number>; scoreHistogram: ScamHistogramBin[]; reviewQueue: ScamReviewRow[] };

type CommentItemContext = {
  context: {
    id: string;
    comment: SocialComment;
    display: { visible: boolean; showLines: boolean; highlightOptions: HighlightOption[] };
    bar: { color: string; width: string };
    circle: Circle;
    replies: { count: number; showViewAsReplyToParentButton: boolean; showViewRepliesButton: boolean };
    analytics: { similarity: { showButton: boolean; similarCommentsCount: number; showScore: boolean; score: number } }
  }
};