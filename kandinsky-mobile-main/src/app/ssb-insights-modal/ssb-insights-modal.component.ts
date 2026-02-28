import { Component, Input, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { ModalController } from '@ionic/angular';
import * as d3 from 'd3';

@Component({
  selector: 'ksky-ssb-insights-modal',
  templateUrl: './ssb-insights-modal.component.html',
  styleUrls: ['./ssb-insights-modal.component.scss'],
})
export class SSBInsightsModalComponent implements AfterViewInit {
  @Input() stats: any; // SSBStats
  @Input() threshold: number;

  // callbacks provided by parent
  @Input() onThresholdChange: (t: number) => void;
  @Input() onSelectComment: (commentId: string) => void;
  @Input() onExportCSV: () => void;

  @ViewChild('tacticSvg', { static: false }) tacticSvg: ElementRef;

  constructor(private modalCtrl: ModalController) {}

  ngAfterViewInit(): void {
    this.drawTacticChart();
  }

  dismiss(): void {
    this.modalCtrl.dismiss();
  }

  handleThresholdChange(ev: any): void {
    var v = ev && ev.detail ? ev.detail.value : null;
    var t = Number(v);
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
    var n = Number(ts);
    if (isNaN(n) || !n) return '';
    // your publishTimestamp looks like ms epoch
    var d = new Date(n);
    // Example: 16 Feb 2026 10:30
    var day = d.getDate();
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var mon = monthNames[d.getMonth()];
    var yr = d.getFullYear();

    var hh = d.getHours();
    var mm = d.getMinutes();
    var mm2 = (mm < 10 ? '0' + mm : '' + mm);

    return day + ' ' + mon + ' ' + yr + ' ' + hh + ':' + mm2;
    }


  selectRow(row: any): void {
    if (!row) return;
    if (this.onSelectComment) this.onSelectComment(row.commentId);
  }

  private drawTacticChart(): void {
    if (!this.tacticSvg || !this.stats || !this.stats.byTactic) return;

    var el = this.tacticSvg.nativeElement as SVGElement;
    var svg = d3.select(el);
    svg.selectAll('*').remove();

    var entries: Array<{ key: string; value: number }> = [];
    var byTactic = this.stats.byTactic;
    Object.keys(byTactic).forEach(k => entries.push({ key: k, value: byTactic[k] }));

    entries.sort((a, b) => b.value - a.value);

    var width = (el as any).clientWidth || 320;
    var height = 180;

    svg.attr('width', width).attr('height', height);

    var margin = { top: 10, right: 10, bottom: 30, left: 90 };
    var innerW = width - margin.left - margin.right;
    var innerH = height - margin.top - margin.bottom;

    var g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

    var y = d3.scaleBand()
      .domain(entries.map(d => d.key))
      .range([0, innerH])
      .padding(0.15);

    var xMax = d3.max(entries, d => d.value) || 1;
    var x = d3.scaleLinear().domain([0, xMax]).range([0, innerW]);

    g.append('g').call(d3.axisLeft(y).tickSize(0) as any);

    g.append('g')
      .attr('transform', 'translate(0,' + innerH + ')')
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
