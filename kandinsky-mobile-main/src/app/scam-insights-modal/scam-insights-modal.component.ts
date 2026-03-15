// scam-insights-modal/scam-insights-modal.component.ts
import { Component, Input, OnInit, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { ModalController } from '@ionic/angular';
import * as d3 from 'd3';

@Component({
  selector: 'ksky-scam-insights-modal',
  templateUrl: './scam-insights-modal.component.html',
  styleUrls: ['./scam-insights-modal.component.scss'],
})
export class ScamInsightsModalComponent implements OnInit, AfterViewInit {
  @Input() stats: any;           // ScamStats
  @Input() threshold: number;

  // Callbacks provided by parent
  @Input() onThresholdChange: (t: number) => void;
  @Input() onSelectComment:   (commentId: string) => void;
  @Input() onExportCSV:       () => void;

  @ViewChild('tacticSvg',    { static: false }) tacticSvg:    ElementRef;
  @ViewChild('timelineSvg',  { static: false }) timelineSvg:  ElementRef;
  @ViewChild('histogramSvg', { static: false }) histogramSvg: ElementRef;

  // ── Local state ───────────────────────────────────────────────────────────
  currentThreshold: number;
  sortField: 'score' | 'tactic' | 'author' = 'score';
  sortAsc = false;
  searchQuery = '';
  filteredQueue: any[] = [];
  expandedRowId: string | null = null;

  // Risk summary
  riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
  riskColor = '#22c55e';
  topTactic = '';
  topTacticCount = 0;
  topSignals: string[] = [];

  constructor(private modalCtrl: ModalController) {}

  ngOnInit(): void {
    this.currentThreshold = this.threshold;
    this.buildRiskSummary();
    this.rebuildQueue();
  }

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.drawTacticChart();
      this.drawTimeline();
      this.drawHistogram();
    }, 80);
  }

  dismiss(): void {
    this.modalCtrl.dismiss();
  }

  exportCSV(): void {
    if (this.onExportCSV) this.onExportCSV();
  }

  // ── Threshold ─────────────────────────────────────────────────────────────
  handleThresholdChange(ev: any): void {
    const v = ev && ev.detail ? ev.detail.value : null;
    const t = Number(v);
    if (isNaN(t)) return;
    this.currentThreshold = t;
    if (this.onThresholdChange) this.onThresholdChange(t);
    setTimeout(() => {
      this.buildRiskSummary();
      this.rebuildQueue();
      this.drawTacticChart();
      this.drawHistogram();
    }, 80);
  }

  // ── Risk summary ──────────────────────────────────────────────────────────
  private buildRiskSummary(): void {
    if (!this.stats) return;
    const ratio = this.stats.flagged / Math.max(1, this.stats.total);
    if (ratio < 0.05)       { this.riskLevel = 'low';      this.riskColor = '#22c55e'; }
    else if (ratio < 0.15)  { this.riskLevel = 'medium';   this.riskColor = '#f59e0b'; }
    else if (ratio < 0.35)  { this.riskLevel = 'high';     this.riskColor = '#ef4444'; }
    else                    { this.riskLevel = 'critical';  this.riskColor = '#7c3aed'; }

    const byTactic = this.stats.byTactic as Record<string, number>;
    const sorted = Object.entries(byTactic).sort((a, b) => b[1] - a[1]);
    if (sorted.length) {
      this.topTactic      = sorted[0][0];
      this.topTacticCount = sorted[0][1];
    }

    // Collect top signals across review queue
    const sigCount: Record<string, number> = {};
    (this.stats.reviewQueue || []).forEach((row: any) => {
      (row.signals || []).forEach((s: string) => {
        sigCount[s] = (sigCount[s] || 0) + 1;
      });
    });
    this.topSignals = Object.entries(sigCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(e => e[0]);
  }

  // ── Review queue ──────────────────────────────────────────────────────────
  rebuildQueue(): void {
    if (!this.stats || !this.stats.reviewQueue) {
      this.filteredQueue = [];
      return;
    }
    let q = [...this.stats.reviewQueue];
    if (this.searchQuery.trim()) {
      const lc = this.searchQuery.toLowerCase();
      q = q.filter((r: any) =>
        (r.author || '').toLowerCase().includes(lc) ||
        (r.preview || '').toLowerCase().includes(lc) ||
        (r.tactic || '').toLowerCase().includes(lc)
      );
    }
    q.sort((a: any, b: any) => {
      let diff = 0;
      if (this.sortField === 'score')  diff = a.score - b.score;
      if (this.sortField === 'tactic') diff = (a.tactic || '').localeCompare(b.tactic || '');
      if (this.sortField === 'author') diff = (a.author || '').localeCompare(b.author || '');
      return this.sortAsc ? diff : -diff;
    });
    this.filteredQueue = q;
  }

  setSort(field: 'score' | 'tactic' | 'author'): void {
    if (this.sortField === field) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortField = field;
      this.sortAsc = false;
    }
    this.rebuildQueue();
  }

  toggleRow(id: string): void {
    this.expandedRowId = this.expandedRowId === id ? null : id;
  }

  selectRow(row: any): void {
    if (!row) return;
    if (this.onSelectComment) this.onSelectComment(row.commentId);
  }

  formatTs(ts: any): string {
    const n = Number(ts);
    if (isNaN(n) || !n) return '';
    const d = new Date(n);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const hh = d.getHours(), mm = d.getMinutes();
    return `${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm < 10 ? '0' + mm : mm}`;
  }

  tacticLabel(t: string): string {
    return (t || 'SCAM_BOT').replace('SCAM_', '');
  }

  tacticColor(t: string): string {
    const MAP: Record<string, string> = {
      SCAM_FUNNEL: '#f59e0b', SCAM_CRYPTO: '#ff0066', SCAM_ADULT: '#ec4899',
      SCAM_ROMANCE: '#a855f7', SCAM_GIVEAWAY: '#06b6d4', SCAM_BOT: '#ef4444',
    };
    return MAP[t] || '#ef4444';
  }

  // ── D3 Charts ─────────────────────────────────────────────────────────────
  drawTacticChart(): void {
    if (!this.tacticSvg || !this.stats || !this.stats.byTactic) return;
    const el  = this.tacticSvg.nativeElement as SVGElement;
    const svg = d3.select(el);
    svg.selectAll('*').remove();

    const entries: Array<{ key: string; value: number }> = Object.entries(this.stats.byTactic)
      .map(([k, v]) => ({ key: k, value: v as number }))
      .sort((a, b) => b.value - a.value);

    const width  = (el as any).clientWidth  || 300;
    const height = Math.max(140, entries.length * 30);
    const margin = { top: 6, right: 10, bottom: 24, left: 90 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const y = d3.scaleBand().domain(entries.map(d => d.key)).range([0, innerH]).padding(0.22);
    const x = d3.scaleLinear().domain([0, d3.max(entries, d => d.value) || 1]).range([0, innerW]);

    g.append('g')
      .call(d3.axisLeft(y).tickSize(0) as any)
      .selectAll('text')
      .style('fill', '#888')
      .style('font-size', '10px')
      .text((d: any) => this.tacticLabel(d));

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(4) as any)
      .selectAll('text').style('fill', '#555').style('font-size', '10px');

    g.selectAll('.bar').data(entries).enter().append('rect')
      .attr('class', 'bar')
      .attr('x', 0)
      .attr('y', (d: any) => y(d.key) as any)
      .attr('height', y.bandwidth())
      .attr('width', 0)
      .attr('rx', 3)
      .attr('fill', (d: any) => this.tacticColor(d.key))
      .attr('opacity', 0.8)
      .transition().duration(550)
      .attr('width', (d: any) => x(d.value));

    g.selectAll('.bar-label').data(entries).enter().append('text')
      .attr('x', (d: any) => x(d.value) + 5)
      .attr('y', (d: any) => (y(d.key) as any) + y.bandwidth() / 2 + 4)
      .style('fill', '#666').style('font-size', '10px')
      .text((d: any) => d.value);
  }

  drawTimeline(): void {
    if (!this.timelineSvg || !this.stats || !this.stats.reviewQueue) return;
    const el  = this.timelineSvg.nativeElement as SVGElement;
    const svg = d3.select(el);
    svg.selectAll('*').remove();

    const queue = this.stats.reviewQueue as any[];
    if (!queue.length) return;

    // Group by hour
    const byHour = new Map<number, number>();
    queue.forEach((r: any) => {
      const h = Math.floor(r.publishTimestamp / 3600000) * 3600000;
      byHour.set(h, (byHour.get(h) || 0) + 1);
    });
    const entries = Array.from(byHour.entries()).map(([t, c]) => ({ t, c })).sort((a, b) => a.t - b.t);
    if (entries.length < 2) return;

    const width  = (el as any).clientWidth  || 300;
    const height = 90;
    const margin = { top: 10, right: 12, bottom: 28, left: 32 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain(d3.extent(entries, d => d.t) as [number,number]).range([0, innerW]);
    const y = d3.scaleLinear().domain([0, d3.max(entries, d => d.c) || 1]).range([innerH, 0]);

    const area = d3.area<{t:number;c:number}>()
      .x(d => x(d.t)).y0(innerH).y1(d => y(d.c)).curve(d3.curveCatmullRom);
    const line = d3.line<{t:number;c:number}>()
      .x(d => x(d.t)).y(d => y(d.c)).curve(d3.curveCatmullRom);

    g.append('defs').append('linearGradient').attr('id', 'tl-grad')
      .attr('gradientUnits', 'userSpaceOnUse').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', innerH)
      .selectAll('stop').data([
        { offset: '0%', color: 'rgba(239,68,68,0.35)' },
        { offset: '100%', color: 'rgba(239,68,68,0.02)' }
      ]).enter().append('stop')
      .attr('offset', d => d.offset).attr('stop-color', d => d.color);

    g.append('path').datum(entries).attr('fill', 'url(#tl-grad)').attr('d', area as any);
    g.append('path').datum(entries).attr('fill', 'none')
      .attr('stroke', '#ef4444').attr('stroke-width', 1.5).attr('d', line as any);

    g.append('g').attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat((d: any) => {
        const dt = new Date(d);
        return `${dt.getDate()}/${dt.getMonth()+1}`;
      }) as any)
      .selectAll('text').style('fill', '#555').style('font-size', '9px');

    g.append('g').call(d3.axisLeft(y).ticks(3) as any)
      .selectAll('text').style('fill', '#555').style('font-size', '9px');
  }

  drawHistogram(): void {
    if (!this.histogramSvg || !this.stats || !this.stats.scoreHistogram) return;
    const el  = this.histogramSvg.nativeElement as SVGElement;
    const svg = d3.select(el);
    svg.selectAll('*').remove();

    const bins = this.stats.scoreHistogram as Array<{start:number;end:number;count:number}>;
    const width  = (el as any).clientWidth  || 300;
    const height = 80;
    const margin = { top: 6, right: 10, bottom: 22, left: 30 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([0, 1]).range([0, innerW]);
    const y = d3.scaleLinear().domain([0, d3.max(bins, d => d.count) || 1]).range([innerH, 0]);
    const bw = innerW / bins.length;

    g.selectAll('.hbar').data(bins).enter().append('rect')
      .attr('x', (d: any) => x(d.start))
      .attr('y', (d: any) => y(d.count))
      .attr('width', bw - 1)
      .attr('height', (d: any) => innerH - y(d.count))
      .attr('fill', (d: any) => d3.interpolateRdYlGn(1 - d.start))
      .attr('rx', 2).attr('opacity', 0.75);

    // Threshold indicator line
    const threshNorm = this.currentThreshold / 200;
    g.append('line')
      .attr('x1', x(threshNorm)).attr('x2', x(threshNorm))
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', '#fff').attr('stroke-width', 1.5).attr('stroke-dasharray', '3,3');

    g.append('g').attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(d => `${Math.round((d as number) * 100)}%`) as any)
      .selectAll('text').style('fill', '#555').style('font-size', '9px');
  }
}