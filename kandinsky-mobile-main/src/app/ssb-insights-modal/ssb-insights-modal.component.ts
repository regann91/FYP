import { Component, Input, OnInit, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { ModalController } from '@ionic/angular';
import * as d3 from 'd3';

@Component({
  selector: 'ksky-ssb-insights-modal',
  templateUrl: './ssb-insights-modal.component.html',
  styleUrls: ['./ssb-insights-modal.component.scss'],
})
export class SSBInsightsModalComponent implements OnInit, AfterViewInit {
  @Input() stats: any;         // SSBStats
  @Input() threshold: number;

  // callbacks provided by parent
  @Input() onThresholdChange: (t: number) => void;
  @Input() onSelectComment: (commentId: string) => void;
  @Input() onExportCSV: () => void;

  @ViewChild('tacticSvg', { static: false }) tacticSvg: ElementRef;

  // --- New fields for category filtering ---
  public categories: string[] = [];          // all category keys (e.g. SCAM_CRYPTO, SCAM_ADULT, etc.)
  public selectedCategories: string[] = [];  // categories currently selected in the dropdown
  public filteredReviewQueue: any[] = [];    // filtered list of reviewQueue rows

  constructor(private modalCtrl: ModalController) {}

  ngOnInit(): void {
    // Initialize categories from stats and select all by default
    if (this.stats && this.stats.byTactic) {
      this.categories = Object.keys(this.stats.byTactic);
    }
    // Default to selecting all categories when modal opens
    this.selectedCategories = this.categories.slice();
    // Initialize filtered queue to show all results
    this.filteredReviewQueue = this.stats && this.stats.reviewQueue
      ? [...this.stats.reviewQueue]
      : [];
  }

  ngAfterViewInit(): void {
    this.drawTacticChart();
  }

  dismiss(): void {
    this.modalCtrl.dismiss();
  }

  handleThresholdChange(ev: any): void {
    const v = ev && ev.detail ? ev.detail.value : null;
    const t = Number(v);
    if (isNaN(t)) return;

    this.threshold = t;
    if (this.onThresholdChange) this.onThresholdChange(t);

    // redraw with updated stats from parent (parent will update stats reference)
    setTimeout(() => this.drawTacticChart(), 0);
  }

  exportCSV(): void {
    if (this.onExportCSV) this.onExportCSV();
  }

  formatTs(ts: any): string {
    const n = Number(ts);
    if (isNaN(n) || !n) return '';
    const d = new Date(n);
    const day = d.getDate();
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mon = monthNames[d.getMonth()];
    const yr = d.getFullYear();
    const hh = d.getHours();
    const mm = d.getMinutes();
    const mm2 = (mm < 10 ? '0' + mm : '' + mm);
    return `${day} ${mon} ${yr} ${hh}:${mm2}`;
  }

  selectRow(row: any): void {
    if (!row) return;
    if (this.onSelectComment) this.onSelectComment(row.commentId);
  }

  /** Called when the user changes the category selection dropdown */
  public handleCategoryChange(ev: any): void {
    this.selectedCategories = ev.detail.value || [];
    this.updateFilteredQueue();
  }

  /** Filter the review queue based on selected categories */
  private updateFilteredQueue(): void {
    if (!this.stats || !this.stats.reviewQueue) {
      this.filteredReviewQueue = [];
      return;
    }
    if (!this.selectedCategories || this.selectedCategories.length === 0) {
      // No categories selected => show no rows
      this.filteredReviewQueue = [];
    } else {
      // Filter rows whose tactic is in the selected categories
      this.filteredReviewQueue = this.stats.reviewQueue.filter((row: any) =>
        this.selectedCategories.includes(row.tactic)
      );
    }
  }

  private drawTacticChart(): void {
    if (!this.tacticSvg || !this.stats || !this.stats.byTactic) return;

    const el = this.tacticSvg.nativeElement as SVGElement;
    const svg = d3.select(el);
    svg.selectAll('*').remove();

    const entries: Array<{ key: string; value: number }> = [];
    const byTactic = this.stats.byTactic;
    Object.keys(byTactic).forEach(k => entries.push({ key: k, value: byTactic[k] }));

    entries.sort((a, b) => b.value - a.value);

    const width = (el as any).clientWidth || 320;
    const height = 180;

    svg.attr('width', width).attr('height', height);

    const margin = { top: 10, right: 10, bottom: 30, left: 90 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const y = d3.scaleBand()
      .domain(entries.map(d => d.key))
      .range([0, innerH])
      .padding(0.15);

    const xMax = d3.max(entries, d => d.value) || 1;
    const x = d3.scaleLinear().domain([0, xMax]).range([0, innerW]);

    g.append('g').call(d3.axisLeft(y).tickSize(0) as any);
    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(4) as any);

    g.selectAll('.bar')
      .data(entries)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('x', 0)
      .attr('y', d => y(d.key) as any)
      .attr('height', y.bandwidth())
      .attr('width', d => x(d.value));
  }
}