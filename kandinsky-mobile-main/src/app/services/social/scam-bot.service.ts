import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SocialComment } from 'src/app/models/models';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ScamBotService {

  // later move this to environment.ts
  private apiUrl = 'http://localhost:8000/analyze';

  constructor(private http: HttpClient) {}

  analyzeComments(comments: SocialComment[]): Observable<any[]> {
    const body = {
      comments: comments.map(c => ({
        comment_id: c.id,
        text: c.content,
        author: c.authorName,
        author_channel_id: c.authorChannelId || null,
        author_profile_image_url: c.authorProfileImageUrl || null,
        publish_timestamp: c.publishTimestamp,
        like_count: c.likeCount,
        parent_comment_id: c.parentCommentId || null
      }))
    };
    return this.http.post<any[]>(this.apiUrl, body);
  }
}