import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SocialComment } from 'src/app/models/models';
import { Observable } from 'rxjs';
import { StorageServiceFactory } from 'src/app/services/storage-factory.service';


@Injectable({
  providedIn: 'root'
})
export class ScamBotService {

  // later move this to environment.ts
  private apiUrl = 'http://localhost:8000/analyze';

  constructor(private http: HttpClient, private storageFactory: StorageServiceFactory) {}

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
  /**
   * Retrieve cached SSB results for a given videoId from local storage.
   */
  public async getCachedResults(videoId: string): Promise<any[]> {
    const store = this.storageFactory.getStorageService('ssb-results');
    try {
      const results = await store.getItem(videoId);
      // Check if results exists and is an array
      if (results && Array.isArray(results)) {
        return results;
      }
      return [];
    } catch (err) {
      console.warn(`SCM: error retrieving cached SSB results for video ${videoId}:`, err);
      return [];
    }
  }

  /**
   * Cache SSB results for a given videoId to local storage.
   */
  public async cacheResults(videoId: string, results: any[]): Promise<void> {
    const store = this.storageFactory.getStorageService('ssb-results');
    try {
      await store.setItem(videoId, results);
    } catch (err) {
      console.error(`SCM: error caching SSB results for video ${videoId}:`, err);
    }
}
}