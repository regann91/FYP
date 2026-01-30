import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ScamBotService {

  // later move this to environment.ts
  private apiUrl = 'http://localhost:8000/analyze';

  constructor(private http: HttpClient) {}

  analyzeComments(comments: string[]): Observable<any[]> {
    // Wrap the array in an object to match the Python BaseModel
    const body = { comments: comments }; 
    
    return this.http.post<any[]>(this.apiUrl, body);
  }
}
