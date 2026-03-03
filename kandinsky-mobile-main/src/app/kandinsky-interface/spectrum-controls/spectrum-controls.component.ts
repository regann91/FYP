import { Component, OnInit, Input, OnChanges, SimpleChanges, Output, EventEmitter } from '@angular/core';
import { Selection, ScaleBand, ScaleLogarithmic } from 'd3';
import * as d3 from 'd3';
import _ from 'lodash';
import { ACTIVE_BAR_COLOR, MIN_SPECTRUM, PASSIVE_BAR_COLOR } from 'src/app/config';

/**
 * Spectrum component — displays comment density histogram with a dual-knob
 * range selector. SSB controls have been moved to the dedicated SSB tab.
 */
@Component({
  selector: 'ksky-spectrum-controls',
  templateUrl: './spectrum-controls.component.html',
  styleUrls: ['./spectrum-controls.component.scss'],
})
export class SpectrumControlsComponent implements OnInit, OnChanges {

  protected readonly MIN_RANGE_VALUE = MIN_SPECTRUM;

  @Input()  intervals: SpectrumInterval[];
  @Input()  range: SpectrumRange;
  @Output() rangeChange = new EventEmitter<SpectrumRange>();

  private componentContainer: Selection<SVGGElement, any, HTMLElement, any>;
  private yScale: ScaleLogarithmic<number, number>;
  private xScale: ScaleBand<string>;

  private readonly ACTIVE_BAR_COLOR  = ACTIVE_BAR_COLOR;
  private readonly PASSIVE_BAR_COLOR = PASSIVE_BAR_COLOR;

  constructor() {}

  ngOnInit() {
    if (!this.range) {
      this.range = {
        lower: Math.floor(this.intervals.length * 0.25),
        upper: Math.floor(this.intervals.length * 0.75)
      };
    }
    setTimeout(() => { this.prepareLayout(); });
    if (this.intervals && this.intervals.length > 0) {
      setTimeout(() => { this.updateBars(this.intervals); this.repaintBars(); });
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes.intervals && !changes.intervals.isFirstChange()) {
      setTimeout(() => { this.updateBars(this.intervals); });
    }
  }

  protected dualRangeChange(): void {
    this.rangeChange.emit(this.range);
    this.repaintBars();
  }

  private repaintBars(): void {
    this.componentContainer
      .selectAll<any, SpectrumInterval>('.bar')
      .style('fill', (d, i) =>
        (i >= this.range.lower && i <= this.range.upper) ? this.ACTIVE_BAR_COLOR : this.PASSIVE_BAR_COLOR
      );

    this.componentContainer
      .select('.select-overlay')
      .attr('x', () => this.xScale(this.range.lower + ''))
      .attr('width', this.xScale.step() * (this.range.upper - this.range.lower + 1));
  }

  private updateBars(intervalData: SpectrumInterval[]): void {
    const values = intervalData.map(b => b.heightValue);

    this.yScale = d3.scaleLog()
      .clamp(true)
      .domain([0.1, Math.max(...values)])
      .range([Number(this.componentContainer.attr('height')), 0])
      .nice();

    this.xScale = d3.scaleBand()
      .domain(_.range(0, intervalData.length).map(i => i + ''))
      .range([0, Number(this.componentContainer.attr('width'))])
      .padding(0.1);

    this.componentContainer
      .selectAll('.bar')
      .data(intervalData)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('x', (d, i) => this.xScale(i + ''))
      .attr('width', this.xScale.bandwidth())
      .attr('y', d => this.yScale(d.heightValue))
      .attr('height', d => Number(this.componentContainer.attr('height')) - this.yScale(d.heightValue));

    this.componentContainer
      .append('rect')
      .attr('class', 'select-overlay')
      .attr('fill', 'black')
      .style('opacity', 0.25)
      .attr('y', 0)
      .attr('height', Number(this.componentContainer.attr('height')));
  }

  private prepareLayout(): void {
    const spectrumSvg = d3.select<SVGElement, unknown>('svg.spectrum-canvas');
    if (this.componentContainer) this.componentContainer.remove();
    this.componentContainer = spectrumSvg
      .append('g')
      .attr('width',  spectrumSvg.property('clientWidth'))
      .attr('height', spectrumSvg.property('clientHeight'));
  }
}

export type SpectrumRange    = { upper: number; lower: number };
export type SpectrumInterval = { heightValue: number };