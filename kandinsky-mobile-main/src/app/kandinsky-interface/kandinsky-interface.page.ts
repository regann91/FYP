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
import { SSBResultFull } from './ssb-canvas/ssb-canvas.component';

export type ActiveTab = 'visualisation' | 'ssb';

@Component({
  selector: 'ksky-kandinsky-interface',
  templateUrl: './kandinsky-interface.page.html',
  styleUrls: ['./kandinsky-interface.page.scss'],
})
export class KandinskyInterfacePage implements OnInit {

  // ── tab state ─────────────────────────────────────────────────────────────
  activeTab: ActiveTab = 'visualisation';

  // ── SSB state (shared between tab bar badge and SSB canvas) ───────────────
  ssbResultsMap = new Map<string, SSBResultFull>();
  ssbThreshold  = 85;   // 0-100 scale (API returns raw score 0-200+)
  ssbStats: SSBStats | null = null;
  scamCommentIds: string[] = [];
  allComments: SocialComment[] = [];

  // Internal SSB fields (kept for CSV export / insights modal)
  private lastSSBResults: SSBResultFull[] = [];

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
  protected ssbLoading = false;

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
    this.activeTab = tab;
    // Reset canvas zoom when returning to visualisation tab
    if (tab === 'visualisation') {
      setTimeout(() => this.canvas && this.canvas.resetZoom(), 50);
    }
  }

  // ── SSB analysis — called from SSB tab header ─────────────────────────────
  async runSSBAnalysis(): Promise<void> {
    // const loading = await createLoading(this.loadingController, 'Analyzing comments…');
    // await loading.present();

    this.scamBotService.analyzeComments(this.allComments).subscribe({
      next: (results: any[]) => {
        this.lastSSBResults = results;

        this.ssbResultsMap = new Map(
          results.map((r, i) => {
            const c = this.allComments[i];
            return c ? [c.id, r as SSBResultFull] : null;
          }).filter(Boolean) as [string, SSBResultFull][]
        );

        this.ssbStats = this.buildSSBStats(this.allComments, results, this.ssbThreshold);
        this.scamCommentIds = this.ssbStats.reviewQueue.map(r => r.commentId);
      },
      error: (err) => {
        console.error('SSB analyze failed', err);
        // loading.dismiss();
      }
    });
  }

  // ── called by SSB canvas when user clicks a node ──────────────────────────
  onSSBNodeSelected(data: { comment: SocialComment; result: SSBResultFull } | null) {
    // Nothing needed at page level currently — detail panel is inside ssb-canvas
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
    // ── Fire SSB in background — do NOT await ──────────────────────
    this.ssbLoading = true;
    this.runSSBAnalysis()
      .catch(err => console.warn('SSB background run failed:', err))
      .finally(() => { this.ssbLoading = false; });
    // ──────────────────────────────────────────────────────────────
    await this.createPostInformationModal();
    this.groupedCommentsByTimestamp = this.kandinskyService.groupCommentsByTimestamp(this.NUM_GROUPS);
    this.spectrumIntervals = this.groupedCommentsByTimestamp.map(g => ({ heightValue: g.comments.length }));
    this.canvas.constructCanvas(this.allComments);
  }

  protected onCanvasReady(): void {
    this.loadingController.dismiss();
  }

  // ── post information modal ────────────────────────────────────────────────
  protected async displayPostInformation(): Promise<void> {
    await this.postInformationModal.present();
    this.postInformationModal.onDidDismiss().then(async () => await this.createPostInformationModal());
  }

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

  // ── circle selection ──────────────────────────────────────────────────────
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

  // ── timeline ──────────────────────────────────────────────────────────────
  protected timestampChange(progress: number): void {
    setTimeout(() => {
      this.updateCommentContexts();
      if (this.selectedConcentricCircle && !this.selectedConcentricCircle.isDisplayed) {
        this.canvas.selectByPivotId(null);
      }
    });
    this.timestamp = progress !== -1 ? this.kandinskyService.getCommentTimestamp(progress) : 0;
  }

  // ── search ────────────────────────────────────────────────────────────────
  protected search(query: string = ''): void {
    this.isSearchFocusModeOn = query.length > 0;
    this.searchResult = this.kandinskyService.searchComments(query);
    this.canvas.setFocused(Object.keys(this.searchResult));

    const commentContextsToUpdate: CommentItemContext[] = [];
    if (this.isShowCommentsOn) commentContextsToUpdate.push(this.commentContext, ...this.commentRepliesContexts);
    if (this.isShowSimilarCommentsOn) commentContextsToUpdate.push(this.referenceCommentContext, ...this.similarCommentsContexts);

    commentContextsToUpdate.filter(c => c && c.context.display.visible).forEach(c => {
      const match = this.searchResult[c.context.comment.id];
      c.context.display.highlightOptions = [
        c.context.display.highlightOptions[0],
        { ...c.context.display.highlightOptions[1], indices: match || [] }
      ];
    });

    this.searchResultIds = this.kandinskyService.getActivePostComments()
      .filter(c => this.searchResult[c.id] !== undefined).map(c => c.id);
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

  private goToSearchResult(commentId: string): void {
    const comments = this.kandinskyService.getActivePostComments();
    const target = comments.find(c => c.id === commentId);
    if (!target) return;
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

  // ── spectrum ──────────────────────────────────────────────────────────────
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

  // ── SSB insights modal ────────────────────────────────────────────────────
  async openSSBInsights(): Promise<void> {
    if (!this.ssbStats) return;
    const modal = await this.modalController.create({
      component: (await import('../ssb-insights-modal/ssb-insights-modal.component')).SSBInsightsModalComponent as any,
      componentProps: {
        stats: this.ssbStats,
        threshold: this.ssbThreshold,
        onThresholdChange: (t: number) => {
          this.ssbThreshold = t;
          this.ssbStats = this.buildSSBStats(this.allComments, this.lastSSBResults, t);
          this.scamCommentIds = this.ssbStats.reviewQueue.map(r => r.commentId);
          // Re-trigger SSB canvas to rebuild with new threshold
          this.ssbResultsMap = new Map(this.ssbResultsMap);
        },
        onExportCSV: () => this.downloadSSBScamsCSV()
      },
      cssClass: 'auto-sized-modal'
    });
    await modal.present();
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  downloadSSBScamsCSV(): void {
    if (!this.lastSSBResults.length) return;

    const header = ['comment_id','author','publish_timestamp','score','tactic','label','text'];
    const rows = [header.join(',')];
    const n = Math.min(this.allComments.length, this.lastSSBResults.length);

    for (let i = 0; i < n; i++) {
      const c = this.allComments[i];
      const r = this.lastSSBResults[i];
      if (!r || r.label !== 'SCAM') continue;
      const score = Number(r.score);
      if (isNaN(score) || score < this.ssbThreshold) continue;
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
    a.download = `ssb_scams_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  private csvEsc(v: any): string {
    const s = v == null ? '' : String(v);
    return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ── SSB stats builder (reused by insights modal) ──────────────────────────
  private buildSSBStats(comments: SocialComment[], results: any[], threshold: number): SSBStats {
    const total = comments.length;
    let flagged = 0;
    const byTactic: Record<string, number> = {};
    const byRuleTag: Record<string, number> = {};
    const bins: SSBHistogramBin[] = Array.from({ length: 10 }, (_, b) => ({
      start: b / 10, end: (b + 1) / 10, count: 0
    }));
    const reviewQueue: SSBReviewRow[] = [];
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
    const searchResult = this.searchResult ? this.searchResult[comment.id] : null;
    const totalReplyCount = comment.commentCount > 0 ? this.canvas.countDisplayedCircles(circleDatum.children) : 0;
    const similarCommentsCount = Object.keys(this.kandinskyService.getSimilarCommentScores(comment)).length;
    const topicIndices = [].concat.apply([], [...Object.values(comment.analytics.topics)].map((t: any) => t.indices));
    const barParams = this.canvas.paintCommentBar(circleDatum, this.barWidthScale, this.isShowSimilarCommentsOn);

    return {
      context: {
        id: `comment-${comment.id}`,
        comment,
        display: {
          visible: forceVisibility || this.canvas.shouldDisplayCircle(circleDatum) || searchResult !== null,
          showLines,
          highlightOptions: [
            { indices: topicIndices, color: 'yellow', textColor: 'black' },
            { indices: searchResult || [], color: 'blue', textColor: 'white' }
          ]
        },
        bar: { ...barParams, width: `${barParams.width}px` },
        circle: circleDatum,
        replies: {
          count: totalReplyCount,
          showViewAsReplyToParentButton: showRepliesButton && this.canvas.getIsPivot(circleDatum) && comment.parentCommentId !== null,
          showViewRepliesButton: showRepliesButton && !this.canvas.getIsPivot(circleDatum) && totalReplyCount > 0
        },
        analytics: {
          similarity: {
            similarCommentsCount, score: similarityScore,
            showScore: showSimilarityScore,
            showButton: showSimilaritiesButton && similarCommentsCount > 0
          }
        }
      }
    };
  }

  private updateCommentContexts(): void {
    const commentContextsToUpdate: CommentItemContext[] = [];
    let prevVisible = 0, newVisible = 0;

    if (this.isShowCommentsOn) {
      prevVisible = this.visibleCommentsCount;
      commentContextsToUpdate.push(this.commentContext, ...this.commentRepliesContexts);
      this.visibleCommentsCount = this.canvas.countDisplayedCircles(
        [this.selectedConcentricCircle.pivot, ...this.selectedConcentricCircle.pivot.children]
      );
      newVisible = this.visibleCommentsCount;
    }

    if (this.isShowSimilarCommentsOn) {
      prevVisible = this.visibleSimilarCommentsCount;
      commentContextsToUpdate.push(this.referenceCommentContext, ...this.similarCommentsContexts);
      this.visibleSimilarCommentsCount = this.canvas.countDisplayedCircles(
        this.similarCommentsContexts.map(c => c.context.circle)
      );
      newVisible = this.visibleSimilarCommentsCount;
    }

    commentContextsToUpdate.forEach(ctx => {
      if (!ctx) return;
      ctx.context.display.visible = this.canvas.shouldDisplayCircle(ctx.context.circle);
    });

    if (newVisible > 0 && prevVisible !== newVisible) {
      const last = commentContextsToUpdate.filter(c => c && c.context.display.visible).pop();
      if (last) scrollToElement(last.context.id);
    }
  }

  protected updateDetailedCommentSectionProps(concentricCircleDatum?: ConcentricCircle): void {
    this.selectedConcentricCircle = concentricCircleDatum;
    this.isShowCommentsOn = !!concentricCircleDatum;
    this.visibleCommentsCount = concentricCircleDatum ? this.canvas.countDisplayedCircles(concentricCircleDatum) : 0;
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
type SSBReviewRow  = { commentId: string; author: string; publishTimestamp: number; score: number; tactic: string; label: string; preview: string };
type SSBHistogramBin = { start: number; end: number; count: number };
type SSBStats = { total: number; flagged: number; threshold: number; byTactic: Record<string,number>; byRuleTag: Record<string,number>; scoreHistogram: SSBHistogramBin[]; reviewQueue: SSBReviewRow[] };

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