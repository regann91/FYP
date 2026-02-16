import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type SSBResult = {
  label: 'SCAM' | 'HAM';
  score: number;
  ml_score?: number;
  rule_score?: number;
  rule_triggers?: string[];
};

@Injectable({ providedIn: 'root' })
export class SsbService {
  // Browser dev: FastAPI on your laptop
  // IMPORTANT for device/emulator: you cannot use localhost (see section 5)
  private readonly baseUrl = 'http://localhost:8000';

  constructor(private http: HttpClient) {}

  analyze(comments: string[]): Observable<SSBResult[]> {
    return this.http.post<SSBResult[]>(`${this.baseUrl}/analyze`, { comments });
  }
}
