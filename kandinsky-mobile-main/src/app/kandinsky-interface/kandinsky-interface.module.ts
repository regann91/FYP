// kandinsky-interface.module.ts
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { MomentModule } from 'ngx-moment';
import { KandinskyInterfacePageRoutingModule } from './kandinsky-interface-routing.module';
import { KandinskyInterfacePage } from './kandinsky-interface.page';
import { CanvasComponent } from './canvas/canvas.component';
import { TimelineControlsComponent } from './timeline-controls/timeline-controls.component';
import { HighlightPipe } from '../highlight.pipe';
import { PostInformationModalComponent } from './post-information-modal/post-information-modal.component';
import { SpectrumControlsComponent } from './spectrum-controls/spectrum-controls.component';
import { SanitizeHtmlPipe } from '../sanitize-html.pipe';
import { ScamCanvasComponent } from './scam-canvas/scam-canvas.component';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    KandinskyInterfacePageRoutingModule,
    MomentModule
  ],
  declarations: [
    KandinskyInterfacePage,
    CanvasComponent,
    PostInformationModalComponent,
    TimelineControlsComponent,
    SpectrumControlsComponent,
    HighlightPipe,
    SanitizeHtmlPipe,
    ScamCanvasComponent,
  ],
  entryComponents: [
    PostInformationModalComponent
  ]
})
export class KandinskyInterfacePageModule {}