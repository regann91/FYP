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
import { MIN_PROGRESS, MIN_TIMESTAMP, SPECTRUM_DEFAULT_MODE, SEARCH_DEFAULT_MODE, SEARCH_DEFAULT_QUERY, SHOW_COMMENTS_DEFAULT, MAX_LIKE_BAR_WIDTH_PX, MIN_LIKE_BAR_WIDTH_PX, SHOW_SIMILARITY_DEFAULT, MINIMIZE_REFERENCE_COMMENT, NUM_GROUPS } from 'src/app/config';
import { buildLinearScale, createLoading, isConcentricCircleDatum, scrollToElement } from '../utils';

/**
 * The encompassing primary UI component responsible for displaying the social visualisation of a post and 
 * its comments. The component integrates all UI components.
 */
@Component({
  selector: 'ksky-kandinsky-interface',
  templateUrl: './kandinsky-interface.page.html',
  styleUrls: ['./kandinsky-interface.page.scss'],
})
export class KandinskyInterfacePage implements OnInit {
  protected isSSBEnabled: boolean = false;

  // Store results by comment id
  //private ssbByCommentId = new Map<string, { label: 'SCAM' | 'HAM'; score: number }>();
  private ssbThreshold: number = 0.85;
  private ssbStats: SSBStats = null;
  private ssbByCommentId = new Map<string, SSBResult>();

  // scam comment navigation (mirrors search navigation)
  protected scamCommentIds: string[] = [];
  protected currentScamIndex: number = -1;

  // SSB signal breakdown popover
  protected ssbSignalPopoverCommentId: string | null = null;
  protected ssbSignalPopoverOpen: boolean = false;

  // active post data
  protected post: SocialPost;

  // canvas params
  protected timestamp: number = MIN_TIMESTAMP;

  // timeline controls params
  protected progress: number = MIN_PROGRESS;
  protected maxProgress: number;

  // spectrum controls params
  protected isSpectrumModeOn: boolean = SPECTRUM_DEFAULT_MODE;
  protected spectrumIntervals: SpectrumInterval[];
  protected spectrumRange: SpectrumRange;
  protected spectrumStartTime: number;
  protected spectrumEndTime: number;
  private NUM_GROUPS: number = NUM_GROUPS;
  private lastSSBComments: SocialComment[] = [];
  private lastSSBResults: any[] = [];
  protected allowedScamCategories: Set<string> = new Set<string>([
    'SCAM_CRYPTO',
    'SCAM_ADULT',
    'SCAM_FUNNEL',
    'SCAM_ROMANCE',
    'SCAM_GIVEAWAY',
    'SCAM_BOT'
  ]);


  // search params
  protected isSearchFocusModeOn: boolean = SEARCH_DEFAULT_MODE;
  protected searchQuery: string = SEARCH_DEFAULT_QUERY;
  private searchResult: SearchResult;
  protected searchResultIds: string[] = [];
  protected searchResultCount: number = 0;
  protected currentSearchIndex: number = -1;



  // detailed comment section params
  protected isShowCommentsOn: boolean = SHOW_COMMENTS_DEFAULT;
  protected selectedConcentricCircle: ConcentricCircle;
  protected visibleCommentsCount: number;
  private barWidthScale: d3.ScaleLinear<number, number>;
  private groupedCommentsByTimestamp: CommentGroupInterval[];
  private readonly MAX_LIKE_BAR_WIDTH: number = MAX_LIKE_BAR_WIDTH_PX;
  private readonly MIN_LIKE_BAR_WIDTH: number = MIN_LIKE_BAR_WIDTH_PX;

  // similar comments section params
  protected isShowSimilarCommentsOn: boolean = SHOW_SIMILARITY_DEFAULT;
  protected isReferenceCommentMinimized: boolean = MINIMIZE_REFERENCE_COMMENT;
  protected visibleSimilarCommentsCount: number;

  // comment item contexts (contains information to display)
  // used to avoid angular's change detection calling the buildcontext multiple times
  protected commentContext: CommentItemContext;
  protected commentRepliesContexts: CommentItemContext[];
  protected referenceCommentContext: CommentItemContext;
  protected similarCommentsContexts: CommentItemContext[];

  @ViewChild('timelineControls', { static: false })
  timelineControls: TimelineControlsComponent;

  @ViewChild('canvas', { static: true })
  canvas: CanvasComponent;

  @ViewChild('commentsList', { static: false, read: ElementRef })
  commentsList: ElementRef;

  @ViewChild('searchbar', { static: false })
  searchbar: IonSearchbar;
  
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

  /**
   * Implements the retrieve operator in the abstraction model.
   * @param groupOfCircles A `ConcentricCircle` to return comment data in that thread, or an array of `Circles` to return comment data represented by those circles only.
   */
  private retrieve(groupOfCircles: ConcentricCircle | Circle[]): void {
    if (isConcentricCircleDatum(groupOfCircles)) {
      const circles = this.canvas.getConcentricCircleCircles(groupOfCircles);

      this.commentContext = this.buildCommentItemContext(circles[0]);
      this.commentRepliesContexts = circles.slice(1).map(c => this.buildCommentItemContext(c));
    } else {
      this.referenceCommentContext = this.buildCommentItemContext(groupOfCircles[0], {
        showRepliesButton: false,
        showSimilaritiesButton: false,
        showLines: false,
        forceVisibility: true
      });
      this.similarCommentsContexts = groupOfCircles.slice(1).map(circle => this.buildCommentItemContext(circle, {
        showRepliesButton: false,
        showSimilaritiesButton: false,
        showSimilarityScore: true,
      }));
    }
  }

  /**
   * Initialise the Kandinsky interface page for the active post.
   * @param postId The ID of the active post.
   * @param platform The platform that the post belongs to.
   */
  private async initialize(postId: string, platform: SocialPlatform): Promise<void> {
    
    this.barWidthScale = d3.scaleLinear().range([this.MIN_LIKE_BAR_WIDTH, this.MAX_LIKE_BAR_WIDTH]);

    const loading = await createLoading(this.loadingController);
    
    loading.present();

    console.log('Setting active post...')
    await this.kandinskyService.setActivePost(postId, platform, loading);

    console.time('Preparing data for canvas');
    loading.message = 'Preparing canvas...';
    
    await this.initialiseComponents();
    
    console.timeEnd('Preparing data for canvas');
  }

  /** Initialise the variables and child components of the Kandinsky interface page. */
  private async initialiseComponents(): Promise<void> {
    console.time("Canvas preparation time");
    this.post = this.kandinskyService.getActivePost();
    
    this.maxProgress = this.post.commentCount - 1;

    await this.createPostInformationModal();

    console.log('Grouping comments by timestamp...')
    this.groupedCommentsByTimestamp = this.kandinskyService.groupCommentsByTimestamp(this.NUM_GROUPS);

    this.spectrumIntervals = this.groupedCommentsByTimestamp.map((group) => ({
      heightValue: group.comments.length
    }));

    this.canvas.constructCanvas(this.kandinskyService.getActivePostComments());
  }

  /** Handler when canvas component is ready. */
  protected onCanvasReady(): void {
    this.loadingController.dismiss()
  }

  /** Display information about active post. */
  protected async displayPostInformation(): Promise<void> {
    await this.postInformationModal.present();
    this.postInformationModal.onDidDismiss().then(async () => await this.createPostInformationModal())
  }

  /** Creates the active post information sheet. This function does not display the information sheet, see `displayPostInformation()` instead. */
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

  /** Fetches updated data of the active post from the platform's server. */
  private async reloadDataHandler(): Promise<void> {
    const loading = await createLoading(this.loadingController);
    loading.present();
    await this.kandinskyService.reloadActivePost(loading);
    await this.initialiseComponents();
    this.timelineControls.reset();
  }
  
  /** Removes the active post data from storage. */
  private async deletePostHandler(): Promise<void> {
    const loading = await createLoading(this.loadingController);
    await loading.present();
    await this.kandinskyService.deletePost(this.post.id, this.post.platform, loading);
    await loading.dismiss();
    this.returnToMainMenu();
  }
  
  /** Closes the post information sheet. */
  protected async dismissPostInformation(): Promise<void> {
    this.postInformationModal.dismiss();
  }
  
  /**
   * Selects a specific comment thread and displays a specific comment within that thread.
   * 
   * @remarks
   * Called when 'View replies' or 'View as reply to ...' button is clicked in a comment.
   * 
   * @param pivotId ID of pivot circle of the concentric circle to select. If no value is provided, unselects all comment threads.
   * @param targetCircleId ID of comment in the comment thread to display.
   */
  protected selectConcentricCircle(pivotId?: string, targetCircleId?: string): void {
    this.canvas.selectByPivotId(pivotId);
    if (pivotId && targetCircleId) scrollToElement(`comment-${targetCircleId}`);
  }

  /**
   * Handler for selecting a comment thread.
   * 
   * @remarks
   * Called when the selected circle for the canvas component is changed.
   * 
   * @param concentricCircleDatum `ConcentricCircleDatum` of the comment thread to selected. If no value is provided, it is taken that no comment threads are selected.
   */
  protected selectedConcentricCircleChange(concentricCircleDatum: ConcentricCircle = null): void {
    console.log("Select circle")
    if (this.isShowSimilarCommentsOn) {
      this.selectedSimilarityReferenceCircleChange();
    }

    if(this.timelineControls) {
      this.timelineControls.pause();
    }

    if (this.selectedConcentricCircle === concentricCircleDatum) {
      return;
    }

    this.updateDetailedCommentSectionProps(concentricCircleDatum);

    // scroll up if there are comments for this circle
    if (this.commentsList) {
      this.commentsList.nativeElement.scrollTop = 0;
    }
  }

  /**
   * Handler for selecting a reference comment.
   * 
   * @remarks
   * Called when viewing similar comments for a reference comment.
   * 
   * @param circleDatum `CircleDatum` of the comment selected as the reference comment. If no value is provided, it is taken that similar comments are not being accessed.
   */
  protected selectedSimilarityReferenceCircleChange(circleDatum: Circle = null): void {

    // clear search bar if similarity reference circle is selected
    if (circleDatum) {
      this.searchQuery = '';
    }

    this.updateSimilarityCommentsProps(circleDatum);
  }

  /**
   * Handler for changes made to timeline slider.
   * 
   * @remarks
   * Called by timeline controls on change.
   * 
   * @param progress Chronological zero-based index of comment.
   */
  protected timestampChange(progress: number): void {

    // timeout because of race condition when propagating timestamp to canvas
    setTimeout(() => {

      this.updateCommentContexts();

      if (this.selectedConcentricCircle && !this.selectedConcentricCircle.isDisplayed) {
        // if selected circle disappears, unselect it
        this.canvas.selectByPivotId(null);
      }
    });

    this.timestamp = progress !== -1 ? this.kandinskyService.getCommentTimestamp(progress) : 0;
  }

  /**
   * Performs a query search on all comments.
   * @param query Query string to search for.
   */
  protected search(query: string = ""): void {
    console.time('keyword search');
    this.isSearchFocusModeOn = query.length > 0;
    this.searchResult = this.kandinskyService.searchComments(query);
    this.canvas.setFocused(Object.keys(this.searchResult));

    // update the highlightOptions of visible comments
    const commentContextsToUpdate: CommentItemContext[] = [];

    if (this.isShowCommentsOn) {
      commentContextsToUpdate.push(this.commentContext, ...this.commentRepliesContexts);
    }

    if (this.isShowSimilarCommentsOn) {
      commentContextsToUpdate.push(this.referenceCommentContext, ...this.similarCommentsContexts);
    }

    commentContextsToUpdate
      .filter(c => c.context.display.visible)
      .forEach(c => {

        const match = this.searchResult[c.context.comment.id];

        // must replace list of highlightOptions to trigger change detection and call highlight pipe
        c.context.display.highlightOptions = [
          c.context.display.highlightOptions[0],
          {
            ...c.context.display.highlightOptions[1],
            indices: match || []
          }
        ];
      });
    
    console.timeEnd('keyword search');

    // Prepare list of matching comment IDs for navigation
    this.searchResultIds = this.kandinskyService.getActivePostComments()
      .filter(c => this.searchResult[c.id] !== undefined)
      .map(c => c.id);
    this.currentSearchIndex = -1;

    // this.searchResultIds = Object.keys(this.searchResult);              // list of all comment IDs that matched:contentReference[oaicite:6]{index=6}
    // this.searchResultCount = this.searchResultIds.length;
    if (this.searchResultCount > 0) {
      this.currentSearchIndex = 0;
      const firstId = this.searchResultIds[0];
      const pivotId = this.findPivotId(firstId);
      this.selectConcentricCircle(pivotId, firstId);  // open the thread and scroll to the first matching comment:contentReference[oaicite:7]{index=7}
    }
  }
  // Helper to get the pivot (root comment) ID for a given comment ID
  private findPivotId(commentId: string): string {
    const allComments = this.kandinskyService.getActivePostComments();
    let comment = allComments.find(c => c.id === commentId);
    while (comment && comment.parentCommentId) {
      comment = allComments.find(c => c.id === comment.parentCommentId);
    }
    return comment ? comment.id : commentId;
  }
  // Navigate to the next search result
  protected nextSearchResult(): void {
    if (!this.searchResultCount) return;
    this.currentSearchIndex = (this.currentSearchIndex + 1) % this.searchResultCount;  // wrap around
    const nextId = this.searchResultIds[this.currentSearchIndex];
    const pivotId = this.findPivotId(nextId);
    this.selectConcentricCircle(pivotId, nextId);  // select thread & scroll to next match
  }

  // Navigate to the previous search result
  protected prevSearchResult(): void {
    if (!this.searchResultCount) return;
    this.currentSearchIndex = (this.currentSearchIndex - 1 + this.searchResultCount) % this.searchResultCount;
    const prevId = this.searchResultIds[this.currentSearchIndex];
    const pivotId = this.findPivotId(prevId);
    this.selectConcentricCircle(pivotId, prevId);
  }

  /** Navigate to the previous scam comment (from review queue navigation). */
  protected goToPrevScam(): void {
    if (!this.scamCommentIds.length) return;
    if (this.currentScamIndex <= 0) {
      this.currentScamIndex = this.scamCommentIds.length - 1;
    } else {
      this.currentScamIndex--;
    }
    this.goToScamComment(this.scamCommentIds[this.currentScamIndex]);
  }

  /** Navigate to the next scam comment (from review queue navigation). */
  protected goToNextScam(): void {
    if (!this.scamCommentIds.length) return;
    if (this.currentScamIndex >= this.scamCommentIds.length - 1) {
      this.currentScamIndex = 0;
    } else {
      this.currentScamIndex++;
    }
    this.goToScamComment(this.scamCommentIds[this.currentScamIndex]);
  }

  private goToScamComment(commentId: string): void {
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

  protected goToPrevMatch(): void {
    if (!this.searchResultIds.length) return;
    // Wrap to last match if at beginning or none selected yet
    if (this.currentSearchIndex === -1 || this.currentSearchIndex <= 0) {
      this.currentSearchIndex = this.searchResultIds.length - 1;
    } else {
      this.currentSearchIndex--;
    }
    const commentId = this.searchResultIds[this.currentSearchIndex];
    this.goToSearchResult(commentId);
  }

  protected goToNextMatch(): void {
    if (!this.searchResultIds.length) return;
    // Wrap to first match if at end or none selected yet
    if (this.currentSearchIndex === -1 || this.currentSearchIndex >= this.searchResultIds.length - 1) {
      this.currentSearchIndex = 0;
    } else {
      this.currentSearchIndex++;
    }
    const commentId = this.searchResultIds[this.currentSearchIndex];
    this.goToSearchResult(commentId);
  }

  private goToSearchResult(commentId: string): void {
    // Find the comment and its top-level parent (pivot) ID
    const comments = this.kandinskyService.getActivePostComments();
    const targetComment = comments.find(c => c.id === commentId);
    if (!targetComment) return;
    let pivotCommentId = targetComment.id;
    let parentId = targetComment.parentCommentId;
    while (parentId) {
      const parentComment = comments.find(c => c.id === parentId);
      if (!parentComment) break;
      pivotCommentId = parentComment.id;
      parentId = parentComment.parentCommentId;
    }
    // Select the pivot comment thread and scroll to the target comment
    this.selectConcentricCircle(pivotCommentId, commentId);
  }
    

  /**
   * Sets the search focus mode.
   * @param focused `true` to set search focus mode on; `false` to set it off.
   */
  protected setIsSearchFocusOn(focused: boolean): void {
    this.isSearchFocusModeOn = focused;

    if (focused && this.timelineControls) {
      this.timelineControls.pause();
    }
  }

  private getTextPreview(text: string): string {
    var t = text ? String(text) : '';
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > 160) return t.slice(0, 160) + '…';
    return t;
  }

  private isSSBFlagged(res: SSBResult, threshold: number): boolean {
    if (!res) return false;

    // Your API contract: label is SCAM/HAM; tactic may be SCAM_FUNNEL etc.
    var label = res.label ? String(res.label) : 'HAM';
    var tactic = res.tactic ? String(res.tactic) : '';
    var score = Number(res.score);

    if (isNaN(score)) score = 0;

    var isScamSignal = (label === 'SCAM') || (tactic && tactic.indexOf('SCAM_') === 0);
    return isScamSignal && score >= threshold;
  }

  private buildSSBStats(comments: SocialComment[], results: SSBResult[], threshold: number): SSBStats {
    var total = comments ? comments.length : 0;
    var flagged = 0;

    var byTactic: { [k: string]: number } = {};
    var byRuleTag: { [k: string]: number } = {};

    // score histogram bins
    var bins: SSBHistogramBin[] = [];
    var binCount = 10;
    for (var b = 0; b < binCount; b++) {
      var start = b / binCount;
      var end = (b + 1) / binCount;
      bins.push({ start: start, end: end, count: 0 });
    }

    var reviewQueue: SSBReviewRow[] = [];

    var n = Math.min(comments.length, results.length);
    for (var i = 0; i < n; i++) {
      var c = comments[i];
      var r = results[i];
      if (!c || !r) continue;

      var score = Number(r.score);
      if (isNaN(score)) score = 0;

      // histogram
      var idx = Math.max(0, Math.min(binCount - 1, Math.floor(score * binCount)));
      bins[idx].count += 1;

      var isFlagged = this.isSSBFlagged(r, threshold);
      if (!isFlagged) continue;

      flagged += 1;

      var tactic = r.tactic ? String(r.tactic) : '';
      if (!tactic) tactic = (r.label === 'SCAM') ? 'SCAM' : 'UNKNOWN';

      if (!byTactic[tactic]) byTactic[tactic] = 0;
      byTactic[tactic] += 1;

      var tags = r.debug && r.debug.rule_tags ? r.debug.rule_tags : [];
      if (tags && tags.length) {
        for (var t = 0; t < tags.length; t++) {
          var tag = String(tags[t]);
          if (!byRuleTag[tag]) byRuleTag[tag] = 0;
          byRuleTag[tag] += 1;
        }
      }

      reviewQueue.push({
        commentId: c.id,
        author: c.authorName,
        publishTimestamp: c.publishTimestamp,
        score: score,
        tactic: tactic,
        label: r.label,
        preview: this.getTextPreview(c.content)
      });
    }

    // sort review queue by score desc
    reviewQueue.sort((a, b) => (b.score - a.score));

    // keep list manageable for UI
    if (reviewQueue.length > 300) reviewQueue = reviewQueue.slice(0, 300);

    return {
      total: total,
      flagged: flagged,
      threshold: threshold,
      byTactic: byTactic,
      byRuleTag: byRuleTag,
      scoreHistogram: bins,
      reviewQueue: reviewQueue
    };
  }


  private csvEscape(value: any): string {
    const s = value === null || value === undefined ? '' : String(value);
    const needsQuotes = s.indexOf(',') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0 || s.indexOf('"') >= 0;
    if (!needsQuotes) return s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  public downloadSSBScamsCSV(): void {
    if (!this.lastSSBComments || !this.lastSSBResults || this.lastSSBResults.length === 0) {
      console.warn('No SSB results available to export yet.');
      return;
    }

    const header = [
      'comment_id',
      'author',
      'publish_timestamp',
      'score',
      'tactic',
      'label',
      'text'
    ];

    const rows: string[] = [];
    rows.push(header.join(','));

    const n = Math.min(this.lastSSBComments.length, this.lastSSBResults.length);

    for (let i = 0; i < n; i++) {
      const c = this.lastSSBComments[i];
      const r = this.lastSSBResults[i];

      if (!r) continue;

      const label = r.label;
      const score = Number(r.score);

      // Keep consistent with your canvas logic:
      var isScam = this.isSSBFlagged(r as any, this.ssbThreshold);
      if (!isScam) continue;

      const row = [
        this.csvEscape(c && c.id ? c.id : ''),
        this.csvEscape(c && c.authorName ? c.authorName : ''),
        this.csvEscape(c && c.publishTimestamp ? c.publishTimestamp : ''),
        this.csvEscape(isNaN(score) ? '' : score),
        this.csvEscape(r.tactic ? r.tactic : ''),
        this.csvEscape(label ? label : ''),
        this.csvEscape(c && c.content ? c.content : '')
      ];

      rows.push(row.join(','));
    }

    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ssb_scams_' + Date.now() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    console.log('CSV exported:', rows.length - 1, 'scam rows');
  }


  /** Handles the SSB Visualisation toggle event from the spectrum controls. */
  protected onSSBToggle(enabled: boolean): void {
    console.log('SSB mode toggled:', enabled);
    this.isSSBEnabled = enabled;

    if (enabled) {
      this.runSSBVisualisation();
    } else {
      this.disableSSBVisualisation();
    }
  }

  private async runSSBVisualisation(): Promise<void> {
    // Use the same source of truth as your UI contexts
    const allComments: SocialComment[] = this.kandinskyService.getActivePostComments();
    console.log(`SSB: sending ${allComments.length} comments to backend`);
    // Check for cached results first
    // const videoID = this.post.id;
    // const cachedResults = await this.scamBotService.getCachedResults(videoID);
    // if (cachedResults && cachedResults.length > 0){
    //   this.lastSSBComments = allComments;
    //   this.lastSSBResults = cachedResults;
    //   this.ssbByCommentId.clear();
    //   for (let i = 0; i < cachedResults.length; i++){
    //     const c = allComments[i];
    //     if (c && c.id) this.ssbByCommentId.set(c.id, cachedResults[i]);
    //   }
    //   this.ssbStats = this.buildSSBStats(this.lastSSBComments, this.lastSSBResults, this.ssbThreshold);
    //   if (this.canvas){
    //     this.canvas.applyScamScores(this.lastSSBComments as any, this.ssbThreshold);
    //   }
    //   this.refreshContextsVisibility();
    //   console.log('SSB: results applied from cache');
    //   return;
    // }
    const loading = await createLoading(this.loadingController, "Analyzing comments...");
    await loading.present();
    this.scamBotService.analyzeComments(allComments).subscribe({
      next: (results: SSBResult[]) => {
        this.lastSSBComments = allComments;
        this.lastSSBResults = results;
        loading.dismiss();
        // store full results by comment id
        this.ssbByCommentId.clear();
        for (var i = 0; i < results.length; i++) {
          var c = allComments[i];
          if (c && c.id) this.ssbByCommentId.set(c.id, results[i]);
        }

        // compute stats at current threshold
        this.ssbStats = this.buildSSBStats(this.lastSSBComments, this.lastSSBResults, this.ssbThreshold);

        // build ordered scam comment ID list for prev/next navigation
        this.scamCommentIds = this.ssbStats.reviewQueue.map(r => r.commentId);
        this.currentScamIndex = -1;

        // apply overlay with threshold
        if (this.canvas) {
          this.canvas.applyScamScores(results as any, this.ssbThreshold);
        }

        // refresh list visibility (uses passesSSB)
        this.refreshContextsVisibility();

        console.log('SSB: results applied');
        // this.scamBotService.cacheResults(videoID, results);
      },

      error: (err) => {
        console.error('SSB: analyzeComments failed', err);
        loading.dismiss();
      }
    });
  }

  private disableSSBVisualisation(): void {
    this.isSSBEnabled = false;
    this.ssbByCommentId.clear();
    this.ssbStats = null;
    this.scamCommentIds = [];
    this.currentScamIndex = -1;
    this.ssbSignalPopoverOpen = false;
    this.ssbSignalPopoverCommentId = null;

    // Reset canvas scam overlay — pass empty results so no circles stay highlighted
    if (this.canvas) {
      this.canvas.applyScamScores([], this.ssbThreshold);
    }

    // Reset visibility (all comments become visible again)
    this.refreshContextsVisibility();
  }

  /**
 * Recompute visibility for whatever comment contexts are currently being shown,
 * combining: timeline visibility AND SSB filter.
 */
  private refreshContextsVisibility(): void {
    // This reuses your existing logic, but incorporates SSB
    this.updateCommentContexts();
  }

  /** Toggles between timeline spectrum mode. All comments are displayed when spectrum mode is active. */
  protected toggleSpectrumMode(): void {
    this.isSpectrumModeOn = !this.isSpectrumModeOn;
    this.canvas.resetZoom();

    if (this.isSpectrumModeOn) {
      // Display all comments
      this.timestampChange(this.maxProgress);
    } else {
      this.canvas.setHighlighted([]);
    }
  }

  /** Handler for changes made to range of spectrum timelines. */
  protected spectrumRangeChange(): void {
    const lowerGroupIndex = this.spectrumRange.lower === -1 ? 0 : this.spectrumRange.lower;
    const upperGroupIndex = this.spectrumRange.upper === -1 ? 0 : this.spectrumRange.upper;

    this.spectrumStartTime = this.groupedCommentsByTimestamp[lowerGroupIndex].startTimestamp;
    this.spectrumEndTime = this.groupedCommentsByTimestamp[upperGroupIndex].endTimestamp;

    let commentIds: string[] = [];
    for (let groupIndex = lowerGroupIndex; groupIndex <= upperGroupIndex; groupIndex++) {
      commentIds.push(...this.groupedCommentsByTimestamp[groupIndex].comments.map(socialComment => socialComment.id));
    }

    this.canvas.setHighlighted(commentIds);

    // timeout because of race condition when propagating highlight changes to canvas
    setTimeout(() => this.updateCommentContexts());
  }

  protected async openSSBInsights(): Promise<void> {
    if (!this.ssbStats) {
      console.warn('SSB Insights: no stats yet (run SSB first).');
      return;
    }

    const modal = await this.modalController.create({
      component: (await import('../ssb-insights-modal/ssb-insights-modal.component')).SSBInsightsModalComponent as any,
      componentProps: {
        stats: this.ssbStats,
        threshold: this.ssbThreshold,
        allowedCategories: this.allowedScamCategories, // Add this line
        onThresholdChange: (t: number) => {
          this.ssbThreshold = t;
          this.ssbStats = this.buildSSBStats(this.lastSSBComments, this.lastSSBResults, this.ssbThreshold);
          this.scamCommentIds = this.ssbStats.reviewQueue.map(r => r.commentId);
          this.currentScamIndex = -1;

          if (this.canvas) this.canvas.applyScamScores(this.lastSSBResults as any, this.ssbThreshold);
          this.refreshContextsVisibility();
        },
        onSelectComment: (commentId: string) => this.onSelectSSBReviewComment(commentId),
        onExportCSV: () => this.downloadSSBScamsCSV()
      },
      cssClass: 'auto-sized-modal'
    });

    await modal.present();
  }


  /**
   * Constructs UI context data for a comment.
   * @param circleDatum Comment to construct UI context data for.
   * @param showRepliesButton Indicates whether to display the "View Replies" button.
   * @param showSimilaritiesButton Indicates whether to display the "View similar comments" button.
   * @param showLines Indicates whether to use a bottom border for the comment item.
   * @param forceVisibility Indicates if comment's visibility is independent of the timeline slider.
   * @param showSimilarityScore Indicates whether to display the similarity score of the comment when compared with a reference comment.
   * @param similarityScore Sets the value of the similarity score.
   */
  private buildCommentItemContext(circleDatum: Circle, {
    showRepliesButton = true,
    showSimilaritiesButton = true,
    showLines = true,
    forceVisibility = false,
    showSimilarityScore = false,
    similarityScore = 0
  } = {}): CommentItemContext {

    // const comment: SocialComment = this.canvas.getComment(circleDatum);
    const comment: SocialComment = this.kandinskyService.getComment(circleDatum.index);
    const searchResult = this.searchResult ? this.searchResult[comment.id] : null;
    const totalReplyCount = comment.commentCount > 0 ? this.canvas.countDisplayedCircles(circleDatum.children) : 0;
    const similarCommentsCount = Object.keys(this.kandinskyService.getSimilarCommentScores(comment)).length;

    // extract indices to highlight topic terms
    const topicIndices = [].concat.apply([], [...Object.values(comment.analytics.topics)].map(topicInfo => topicInfo.indices));    
    const barParams = this.canvas.paintCommentBar(circleDatum, this.barWidthScale, this.isShowSimilarCommentsOn);
    
    return {
      context: {
        id: `comment-${comment.id}`,
        comment: comment,
        display: {
          visible: forceVisibility || (this.canvas.shouldDisplayCircle(circleDatum) && this.passesSSB(comment.id) || searchResult !== null),
          showLines: showLines,
          highlightOptions: [
            {
              indices: topicIndices,
              color: 'yellow',
              textColor: 'black'
            }, {
              indices: searchResult || [],
              color: 'blue',
              textColor: 'white'
            }
          ]
        },
        bar: {
          ...barParams,
          width: `${barParams.width}px`
        },
        circle: circleDatum,
        replies: {
          count: totalReplyCount,
          showViewAsReplyToParentButton: showRepliesButton && this.canvas.getIsPivot(circleDatum) && comment.parentCommentId !== null,
          showViewRepliesButton: showRepliesButton && !this.canvas.getIsPivot(circleDatum) && totalReplyCount > 0
        },
        analytics: {
          similarity: {
            similarCommentsCount,
            score: similarityScore,
            showScore: showSimilarityScore,
            showButton: showSimilaritiesButton && similarCommentsCount > 0,
          }
        }
      }
    };
  }
  private passesSSB(commentId: string): boolean {
    if (!this.isSSBEnabled) return true;
    const res = this.ssbByCommentId.get(commentId);
    if (!res) return true; // not computed yet
    const tactic = res.tactic ? String(res.tactic) : '';
    // Filter out scams whose tactic is not in allowed set
    if(!this.allowedScamCategories.has(tactic)){
      return false;
    }
    return this.isSSBFlagged(res, this.ssbThreshold);
  }

  private onSelectSSBReviewComment(commentId: string): void {
    if (this.canvas) this.canvas.focusCommentById(commentId);
    scrollToElement('comment-' + commentId);
    // sync nav index so prev/next picks up from here
    const idx = this.scamCommentIds.indexOf(commentId);
    if (idx !== -1) this.currentScamIndex = idx;
    this.goToScamComment(commentId);
  }

  public getSSBResultForComment(commentId: string): any {
    if (!commentId) return null;
    var r = this.ssbByCommentId.get(commentId);
    if (!r) return null;

    var score = Number(r.score);
    if (isNaN(score)) score = 0;

    var tactic = r.tactic ? String(r.tactic) : '';
    var ruleTags = (r.debug && r.debug.rule_tags) ? r.debug.rule_tags : [];
    var mlProb = (r.debug && typeof r.debug.ml_scam_prob === 'number') ? r.debug.ml_scam_prob : null;

    return {
      label: r.label,
      score: score,
      tactic: tactic,
      ruleTags: ruleTags,
      mlProb: mlProb,
      flagged: this.isSSBFlagged(r, this.ssbThreshold)
    };
  }

  /** Returns human-readable signal descriptions for a comment's SSB result. */
  public getSSBSignals(commentId: string): Array<{ signal: string; description: string }> {
    if (!commentId) return [];
    const r = this.ssbByCommentId.get(commentId);
    if (!r) return [];

    const SIGNAL_LABELS: { [k: string]: string } = {
      'account_very_new_<30d':              'Account created less than 30 days ago',
      'account_new_<90d':                   'Account created less than 90 days ago',
      'zero_subscribers':                   'Channel has zero subscribers',
      'zero_videos':                        'Channel has no uploaded videos',
      'zero_likes_new_account':             'No likes received, posted from a new account',
      'duplicate_text_across_authors':      'Identical comment text posted by multiple authors',
      'duplicate_tail_across_authors':      'Identical ending phrase posted by multiple authors',
      'incoherent_tail':                    'Final sentence is semantically unrelated to the comment body',
      'burst_timing_new_accounts':          'Posted in a coordinated burst with other new accounts',
      'collusion_reply_between_new_accounts': 'Reply chain between two new or suspicious accounts',
      'explicit_profile_picture':           'Profile picture flagged as explicit content',
    };

    const signals: string[] = (r as any).signals || (r.debug && (r.debug as any).signals) || [];
    return signals.map(s => ({
      signal: s,
      description: SIGNAL_LABELS[s] || s
    }));
  }

  /** Toggle the SSB signal breakdown popover for a comment. */
  protected toggleSSBSignalPopover(commentId: string, event: Event): void {
    event.stopPropagation();
    if (this.ssbSignalPopoverCommentId === commentId && this.ssbSignalPopoverOpen) {
      this.ssbSignalPopoverOpen = false;
      this.ssbSignalPopoverCommentId = null;
    } else {
      this.ssbSignalPopoverCommentId = commentId;
      this.ssbSignalPopoverOpen = true;
    }
  }

  protected closeSSBSignalPopover(): void {
    this.ssbSignalPopoverOpen = false;
    this.ssbSignalPopoverCommentId = null;
  }



  /** Updates the comments information when changes are made to their visibility. */
  private updateCommentContexts(): void {
    const commentContextsToUpdate: CommentItemContext[] = [];
    let prevVisibileCommentsCount = 0;
    let newVisibleCommentsCount = 0;

    if (this.isShowCommentsOn) {
      prevVisibileCommentsCount = this.visibleCommentsCount;
      commentContextsToUpdate.push(this.commentContext, ...this.commentRepliesContexts);
      this.visibleCommentsCount = this.canvas.countDisplayedCircles([this.selectedConcentricCircle.pivot, ...this.selectedConcentricCircle.pivot.children]);
      newVisibleCommentsCount = this.visibleCommentsCount;
    }
    
    if (this.isShowSimilarCommentsOn) {
      prevVisibileCommentsCount = this.visibleSimilarCommentsCount;
      commentContextsToUpdate.push(this.referenceCommentContext, ...this.similarCommentsContexts);
      this.visibleSimilarCommentsCount = this.canvas.countDisplayedCircles(this.similarCommentsContexts.map(c => c.context.circle));
      newVisibleCommentsCount = this.visibleSimilarCommentsCount;
    }

    commentContextsToUpdate.forEach(commentItemContext => {
    const baseVisible = this.canvas.shouldDisplayCircle(commentItemContext.context.circle);

    if (!this.isSSBEnabled) {
      commentItemContext.context.display.visible = baseVisible;
      return;
    }

    const commentId =
    commentItemContext &&
    commentItemContext.context &&
    commentItemContext.context.comment
      ? commentItemContext.context.comment.id
      : null;
    const ssb = commentId ? this.ssbByCommentId.get(commentId) : null;

    // While results are not ready, keep it visible (so UI doesn't go blank)
    const hasSearchMatch = this.searchResult && this.searchResult[commentId] ? true : false;
    commentItemContext.context.display.visible = baseVisible && (this.passesSSB(commentId) || hasSearchMatch);
  });


    if (newVisibleCommentsCount > 0 && prevVisibileCommentsCount != newVisibleCommentsCount) {
      const lastVisibleCommentContext = commentContextsToUpdate.filter(c => c.context.display.visible).pop();
      scrollToElement(lastVisibleCommentContext.context.id);
    }
  }

  /**
   * Updates the detailed comment information when a comment thread is selected.
   * @param concentricCircleDatum `ConcentricCircleDatum` of the comment thread to selected. If no value is provided, it is taken that no comment threads are selected.
   */
  protected updateDetailedCommentSectionProps(concentricCircleDatum?: ConcentricCircle): void {
    this.selectedConcentricCircle = concentricCircleDatum;
    this.isShowCommentsOn = concentricCircleDatum ? true : false;
    this.visibleCommentsCount = concentricCircleDatum ? this.canvas.countDisplayedCircles(concentricCircleDatum) : 0;
    
    if (!concentricCircleDatum) {
      this.commentContext = null;
      this.commentRepliesContexts = [];
    } else {
      this.retrieve(concentricCircleDatum);
    }
  }

  /**
   * Updates the similar comments information when a reference comment is selected.
   * @param referenceCircleDatum `CircleDatum` of the comment selected as the reference comment. If no value is provided, it is taken that similar comments are not being accessed.
   */
  private updateSimilarityCommentsProps(referenceCircleDatum?: Circle): void {
    if (!referenceCircleDatum) {
      this.isShowSimilarCommentsOn = false;
      this.visibleSimilarCommentsCount = 0;
      this.canvas.setFocused([]);
      return;
    }
    const referenceComment: SocialComment = this.kandinskyService.getComment(referenceCircleDatum.index);

    const similarCommentScores = this.kandinskyService.getSimilarCommentScores(referenceComment);
    const similarCommentIds = Object.keys(similarCommentScores);
    const similarCommentCircles = this.canvas.getCircleData(similarCommentIds);

    // rebuild bar witdh scale with values from comment and similar comments
    this.barWidthScale = this.buildLikeCountBarWidthScale(referenceCircleDatum, ...similarCommentCircles);
    
    // highlight similar circles
    this.canvas.setFocused(similarCommentIds);

    this.isShowSimilarCommentsOn = true;

    this.retrieve([referenceCircleDatum, ...similarCommentCircles]);

    this.similarCommentsContexts.forEach(context => context.context.analytics.similarity.score = similarCommentScores[context.context.comment.id])

    this.visibleSimilarCommentsCount = this.canvas.countDisplayedCircles(similarCommentCircles);
  }

  /**
   * Creates a scale for the number of likes on a comment and its replies (if any).
   * @param circles The collection of `ConcentricCircleDatum` or `CircleDatum` objects to build the like count for.
   * @returns `ScaleLinear` object.
   */
  private buildLikeCountBarWidthScale(...circles: ConcentricCircle[] | Circle[]): d3.ScaleLinear<number, number> {
    let likeCounts = [];
    for (const circle of circles) {
      likeCounts = [...likeCounts, ...this.canvas.getLikeCounts(circle)]
    }
    const likeCountDomain = d3.extent(likeCounts);
    return buildLinearScale(likeCountDomain[0], likeCountDomain[1], this.MIN_LIKE_BAR_WIDTH, this.MAX_LIKE_BAR_WIDTH)
  }

  /** Return to the post menu page. */
  private returnToMainMenu(): void {
    this.navController.navigateBack(['']);
  }
  
}
type SSBResult = {
  label: 'SCAM' | 'HAM';
  score: number;
  tactic?: string | null;
  signals?: string[];
  debug?: {
    rule_score?: number;
    rule_tags?: string[];
    ml_scam_prob?: number;
  };
};

type SSBReviewRow = {
  commentId: string;
  author: string;
  publishTimestamp: number;
  score: number;
  tactic: string;
  label: string;
  preview: string;
};

type SSBHistogramBin = { start: number; end: number; count: number };

type SSBStats = {
  total: number;
  flagged: number;
  threshold: number;
  byTactic: { [k: string]: number };
  byRuleTag: { [k: string]: number };
  scoreHistogram: SSBHistogramBin[];
  reviewQueue: SSBReviewRow[];
};

/** Represents UI data for a comment. */
type CommentItemContext = {
  context: {
    id: string;
    comment: SocialComment;
    display: {
      visible: boolean;
      showLines: boolean;
      highlightOptions: HighlightOption[];
    },
    bar: {
      color: string;
      width: string;
    },
    circle: Circle,
    replies: {
      count: number;
      showViewAsReplyToParentButton: boolean;
      showViewRepliesButton: boolean;
    },
    analytics: {
      similarity: {
        showButton: boolean;
        similarCommentsCount: number;
        showScore: boolean;
        score: number;
      }
    }
  }
}