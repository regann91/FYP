// src/app/services/export.service.ts
import { Injectable } from '@angular/core';
import { StorageServiceFactory } from './storage-factory.service';
import { YoutubeService } from './social/youtube.service';
import { RawSocialPost, RawSocialComment, SocialPlatform } from '../models/models';
import { YOUTUBE_POSTS_STORE_NAME, YOUTUBE_COMMENTS_STORE_NAME } from '../config';

export interface ExportData {
  posts: string;
  comments: string;
}

export interface ExportOptions {
  videoId?: string;
  filename?: string;
  platform?: SocialPlatform;
  includeRawData?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class ExportService {

  constructor(
    private storageFactory: StorageServiceFactory,
    private youtubeService: YoutubeService
  ) {}

  /**
   * Exports data for a specific platform or all platforms.
   */
  public async exportPlatformData(options: ExportOptions = {}): Promise<ExportData> {
    const { platform, videoId, includeRawData = false } = options;

    try {
      if (platform === SocialPlatform.YOUTUBE || !platform) {
        return await this.exportYouTubeData(videoId, includeRawData);
      }
      
      throw new Error(`Export not implemented for platform: ${platform}`);
    } catch (error) {
      console.error('Error exporting platform data:', error);
      throw new Error('Failed to export platform data');
    }
  }

  /**
   * Downloads exported data as CSV files.
   */
  public async downloadPlatformData(options: ExportOptions = {}): Promise<void> {
    const { filename = 'social_media_data' } = options;
    
    try {
      const { posts, comments } = await this.exportPlatformData(options);
      
      // Only download if there's actual data
      if (posts !== 'No posts data available') {
        this.downloadCSVFile(posts, `${filename}_posts.csv`);
      }
      
      if (comments !== 'No comments data available') {
        this.downloadCSVFile(comments, `${filename}_comments.csv`);
      }

      // Show success message or return success indicator
      return Promise.resolve();
    } catch (error) {
      console.error('Error downloading platform data:', error);
      throw error;
    }
  }

  /**
   * Exports all available data from storage.
   */
  public async exportAllStoredData(includeRawData: boolean = false): Promise<ExportData> {
    try {
      const allPosts = await this.getAllStoredPosts();
      const allComments = await this.getAllStoredComments();

      const postsCSV = this.convertPostsToCSV(allPosts, includeRawData);
      const commentsCSV = this.convertCommentsToCSV(allComments, includeRawData);

      return { posts: postsCSV, comments: commentsCSV };
    } catch (error) {
      console.error('Error exporting all stored data:', error);
      throw new Error('Failed to export all stored data');
    }
  }

  /**
   * Gets count of stored posts and comments for UI display.
   */
  public async getStoredDataCounts(): Promise<{posts: number, comments: number}> {
    try {
      const posts = await this.getAllStoredPosts();
      const comments = await this.getAllStoredComments();
      
      return {
        posts: posts.length,
        comments: comments.length
      };
    } catch (error) {
      console.error('Error getting data counts:', error);
      return { posts: 0, comments: 0 };
    }
  }

  /**
   * Exports YouTube-specific data.
   */
  private async exportYouTubeData(videoId?: string, includeRawData: boolean = false): Promise<ExportData> {
    const postsStorage = this.storageFactory.getStorageService(YOUTUBE_POSTS_STORE_NAME);
    const commentsStorage = this.storageFactory.getStorageService(YOUTUBE_COMMENTS_STORE_NAME);

    let posts: RawSocialPost[] = [];
    let comments: RawSocialComment[] = [];

    if (videoId) {
      // Export specific video data
      try {
        const post = await this.getFromStorage(postsStorage, videoId);
        if (post) posts = [post];

        const videoComments = await this.getFromStorage(commentsStorage, videoId);
        if (videoComments) comments = Array.isArray(videoComments) ? videoComments : [videoComments];
      } catch (error) {
        console.warn(`Could not get data for video ${videoId}:`, error);
      }
    } else {
      // Export all YouTube data
      posts = await this.getStoredPostsByStorage(postsStorage);
      comments = await this.getStoredCommentsByStorage(commentsStorage);
    }

    const postsCSV = this.convertPostsToCSV(posts, includeRawData);
    const commentsCSV = this.convertCommentsToCSV(comments, includeRawData);

    return { posts: postsCSV, comments: commentsCSV };
  }

  /**
   * Generic method to get data from storage, handling different storage interfaces.
   */
  private async getFromStorage(storageService: any, key: string): Promise<any> {
  try {
    // LocalForage uses getItem() method
    return await storageService.getItem(key);
  } catch (error) {
    console.warn(`Error getting data for key ${key}:`, error);
    return null;
  }
}
  /**
   * Gets all posts from all platform storage services.
   */
  private async getAllStoredPosts(): Promise<RawSocialPost[]> {
    const allPosts: RawSocialPost[] = [];
    
    // Add YouTube posts
    const youtubePostsStorage = this.storageFactory.getStorageService(YOUTUBE_POSTS_STORE_NAME);
    const youtubePosts = await this.getStoredPostsByStorage(youtubePostsStorage);
    allPosts.push(...youtubePosts);

    // Add other platforms here as needed
    
    return allPosts;
  }

  /**
   * Gets all comments from all platform storage services.
   */
  private async getAllStoredComments(): Promise<RawSocialComment[]> {
    const allComments: RawSocialComment[] = [];
    
    // Add YouTube comments
    const youtubeCommentsStorage = this.storageFactory.getStorageService(YOUTUBE_COMMENTS_STORE_NAME);
    const youtubeComments = await this.getStoredCommentsByStorage(youtubeCommentsStorage);
    allComments.push(...youtubeComments);

    // Add other platforms here as needed
    
    return allComments;
  }

  /**
   * Retrieves all stored posts from a specific storage service.
   */
  private async getStoredPostsByStorage(storageService: any): Promise<RawSocialPost[]> {
  try {
    const posts: RawSocialPost[] = [];
    
    // LocalForage uses keys() method to get all keys
    const keys = await storageService.keys();
    console.log(`Found ${keys.length} post keys:`, keys);
    
    for (const key of keys) {
      const post = await storageService.getItem(key);
      if (post) posts.push(post);
    }

    return posts;
  } catch (error) {
    console.warn('Could not retrieve posts from storage:', error);
    return [];
  }
}

  /**
   * Retrieves all stored comments from a specific storage service.
   */
  private async getStoredCommentsByStorage(storageService: any): Promise<RawSocialComment[]> {
  try {
    const comments: RawSocialComment[] = [];
    
    // LocalForage uses keys() method to get all keys
    const keys = await storageService.keys();
    console.log(`Found ${keys.length} comment keys:`, keys);
    
    for (const key of keys) {
      const commentData = await storageService.getItem(key);
      if (commentData) {
        if (Array.isArray(commentData)) {
          comments.push(...commentData);
        } else {
          comments.push(commentData);
        }
      }
    }

    return comments;
  } catch (error) {
    console.warn('Could not retrieve comments from storage:', error);
    return [];
  }
}

  /**
   * Converts posts to CSV format.
   */
  private convertPostsToCSV(posts: RawSocialPost[], includeRawData: boolean = false): string {
    if (posts.length === 0) {
      return 'No posts data available';
    }

    const baseHeaders = [
      'ID', 'Title', 'Author', 'Publish Date', 'Like Count', 
      'Comment Count', 'Platform', 'Source URL'
    ];

    const headers = includeRawData ? [...baseHeaders, 'Raw Data'] : baseHeaders;

    const rows = posts.map(post => {
      const baseRow = [
        this.escapeCsvValue(post.id),
        this.escapeCsvValue(post.content),
        this.escapeCsvValue(post.authorName),
        new Date(post.publishTimestamp).toISOString(),
        (post.likeCount ? post.likeCount.toString() : '0'),
        (post.commentCount ? post.commentCount.toString() : '0'),
        post.platform,
        this.escapeCsvValue(post.sourceUrl || '')
      ];

      return includeRawData 
        ? [...baseRow, this.escapeCsvValue(JSON.stringify(post.raw))]
        : baseRow;
    });

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  /**
   * Converts comments to CSV format.
   */
  private convertCommentsToCSV(comments: RawSocialComment[], includeRawData: boolean = false): string {
    if (comments.length === 0) {
      return 'No comments data available';
    }

    const baseHeaders = [
      'Comment ID', 'Post ID', 'Content', 'Author', 'Publish Date',
      'Like Count', 'Reply Count', 'Parent Comment ID', 'Parent Author Name'
    ];

    const headers = includeRawData ? [...baseHeaders, 'Raw Data'] : baseHeaders;

    const flattenedComments = this.flattenComments(comments);

    const rows = flattenedComments.map(comment => {
      const baseRow = [
        this.escapeCsvValue(comment.id),
        this.escapeCsvValue(comment.postId || ''),
        this.escapeCsvValue(comment.content),
        this.escapeCsvValue(comment.authorName),
        new Date(comment.publishTimestamp).toISOString(),
        (comment.likeCount ? comment.likeCount.toString() : '0'),
        (comment.commentCount ? comment.commentCount.toString() : '0'),
        this.escapeCsvValue(comment.parentCommentId || ''),
        this.escapeCsvValue(comment.parentAuthorName || '')
      ];

      return includeRawData 
        ? [...baseRow, this.escapeCsvValue(JSON.stringify(comment.raw))]
        : baseRow;
    });

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  /**
   * Flattens nested comment structure.
   */
  private flattenComments(comments: RawSocialComment[]): RawSocialComment[] {
    const flattened: RawSocialComment[] = [];
    
    for (const comment of comments) {
      flattened.push(comment);
      
      if (comment.comments && comment.comments.length > 0) {
        flattened.push(...this.flattenComments(comment.comments));
      }
    }
    
    return flattened;
  }

  /**
   * Escapes CSV values properly.
   */
  private escapeCsvValue(value: string | null | undefined): string {
    if (value == null) return '';
    
    const stringValue = value.toString();
    
    if (stringValue.includes(',') || stringValue.includes('"') || 
        stringValue.includes('\n') || stringValue.includes('\r')) {
      return '"' + stringValue.replace(/"/g, '""') + '"';
    }
    
    return stringValue;
  }

  /**
   * Downloads CSV file.
   */
  private downloadCSVFile(csvContent: string, filename: string): void {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    
    if (link.download !== undefined) {
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } else {
      // Fallback for browsers that don't support download attribute
      window.open(URL.createObjectURL(blob));
    }
  }
}