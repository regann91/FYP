import { Component, OnInit } from '@angular/core';
import { KandinskyService } from '../services/kandinsky.service';
import { ExportService } from '../services/export.service';
import { SocialPost } from '../models/models';
import { AlertController, NavController, LoadingController, ToastController } from '@ionic/angular';
import { StorageServiceFactory } from '../services/storage-factory.service';
import { createLoading, displayToast } from '../utils';
import _ from 'lodash';

/**
 * Home page of the application. Displays previously saved posts and allows users to add new posts.
 */
@Component({
  selector: 'ksky-post-menu',
  templateUrl: './post-menu.page.html',
  styleUrls: ['./post-menu.page.scss'],
})
export class PostMenuPage implements OnInit {
  public posts: SocialPost[]; // Changed to public so template can access it
  private addPostAlert: HTMLIonAlertElement;

  constructor(
    private kandinskyService: KandinskyService,
    private alertController: AlertController,
    private navController: NavController,
    private loadingController: LoadingController,
    private toastController: ToastController,
    private exportService: ExportService,
    private storageServiceFactory: StorageServiceFactory
  ) {}

  ngOnInit() {
  }
  
  ionViewDidEnter() {
    this.createAddPostAlert();
    this.fetchPosts();
  }

  /** Displays menu to allow users to add new posts. */
  public async displayAddPostAlert(): Promise<void> {
    await this.addPostAlert.present();
    this.addPostAlert.onDidDismiss()
    .then(async () => await this.createAddPostAlert());
  }

  /** Creates and pre-loads the menu instance for adding new posts. */
  private async createAddPostAlert(): Promise<void> {
    this.addPostAlert = await this.alertController.create({
      header: 'Add Post',
      subHeader: 'Enter the URL of the social media post to be added. Only Youtube videos are supported at the moment.',
      inputs: [
        {
          name: 'postUrl',
          type: 'url',
          placeholder: 'https://youtube.com/watch?v=...'
        }
      ],
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Add',
          handler: data => {
            const url: string = data.postUrl;
            const postId = this.kandinskyService.extractPostId(url);
            const platform = this.kandinskyService.extractPlatform(url);
            if (!postId) {
              displayToast(this.toastController, 'Unsupported URL provided.');
              return false;
            }
            displayToast(this.toastController, 'Added new post successfully!');
            this.navController.navigateForward(['', 'kandinsky-interface', platform, postId]);
          }
        }
      ]
    });
  }
  
  /** Displays menu for deleting the active post from storage. */
  protected async displayDeletePostAlert(post: SocialPost): Promise<void> {
    const alert = await this.alertController.create({
      header: 'Delete this post?',
      subHeader: 'This will permanently delete all data extracted related to this post.',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Yes, delete post',
          role: 'confirm',
          handler: async () => {
            const loading = await createLoading(this.loadingController);
            await loading.present();
            this.kandinskyService.deletePost(post.id, post.platform, loading);
            await loading.dismiss();
          }
        }
      ]
    });
    await alert.present();
  }

  /** Retrieves and displays posts saved in storage. */
  private async fetchPosts(): Promise<void> {
    const loading = await createLoading(this.loadingController);
    await loading.present();
    const posts = await this.kandinskyService.getPosts();
    this.posts = _.orderBy(posts, post => post.metadata.lastAccessTimestamp, 'desc');
    await loading.dismiss();
  }

  // NEW EXPORT FUNCTIONALITY BELOW

  /**
   * Shows export options and initiates CSV export
   */
  async exportAsCSV() {
    const alert = await this.alertController.create({
      header: 'Export Data',
      message: 'Choose what data to export:',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'All Data',
          handler: () => {
            this.performExport('all');
          }
        },
        {
          text: 'Current Posts Only',
          handler: () => {
            this.performExport('current');
          }
        }
      ]
    });

    await alert.present();
  }

  /**
   * Performs the actual export operation
   */
  private async performExport(type: 'all' | 'current') {
    const loading = await this.loadingController.create({
      message: 'Preparing export...',
      spinner: 'crescent'
    });

    await loading.present();

    try {
      let filename: string;
      
      if (type === 'all') {
        // Export all stored data
        filename = `social_media_data_${this.getDateString()}`;
        await this.exportService.downloadPlatformData({
          filename: filename,
          includeRawData: false
        });
      } else {
        // Export only currently displayed posts
        filename = `current_posts_${this.getDateString()}`;
        await this.exportCurrentPosts(filename);
      }

      await this.showSuccessToast(`Data exported successfully as ${filename}_*.csv`);
    } catch (error) {
      console.error('Export failed:', error);
      await this.showErrorToast('Export failed. Please try again.');
    } finally {
      await loading.dismiss();
    }
  }

  /**
   * Exports only the currently displayed posts
   */
  private async exportCurrentPosts(filename: string) {
    if (!this.posts || this.posts.length === 0) {
      throw new Error('No posts to export');
    }

    // Get comments for each current post
    const allComments: any[] = [];
    const postsForExport: any[] = [];

    for (const post of this.posts) {
      postsForExport.push(post);
      
      // Try to get comments for this post
      try {
        const postComments = await this.getCommentsForPost(post.id, post.platform);
        allComments.push(...postComments);
      } catch (error) {
        console.warn(`Could not get comments for post ${post.id}:`, error);
      }
    }

    // Convert to CSV and download
    const postsCSV = this.convertCurrentPostsToCSV(postsForExport);
    const commentsCSV = allComments.length > 0 ? 
      this.convertCurrentCommentsToCSV(allComments) : 
      'No comments available for current posts';

    this.downloadCSVFile(postsCSV, `${filename}_posts.csv`);
    if (allComments.length > 0) {
      this.downloadCSVFile(commentsCSV, `${filename}_comments.csv`);
    }
  }

  /**
   * Gets comments for a specific post
   */
  private async getCommentsForPost(postId: string, platform: string): Promise<any[]> {
  console.log(`Getting comments for post: ${postId}, platform: ${platform}`);
  
  const storeName = platform === 'YOUTUBE' ? 'youtube-comments' : `${platform.toLowerCase()}-comments`;
  console.log(`Using storage name: ${storeName}`);
  
  const commentsStorage = this.storageServiceFactory.getStorageService(storeName);
  
  try {
    // LocalForage uses getItem() method
    const comments = await commentsStorage.getItem(postId);
    console.log(`Retrieved comments:`, comments);
    
    if (!comments) {
      console.log(`No comments found for post ${postId}`);
      return [];
    }
    
    const result = Array.isArray(comments) ? comments : [comments];
    console.log(`Final comments array length:`, result.length);
    return result;
  } catch (error) {
    console.warn(`Error getting comments for post ${postId}:`, error);
    return [];
  }
}

  /**
   * Converts current posts to CSV format
   */
  private convertCurrentPostsToCSV(posts: any[]): string {
    if (posts.length === 0) {
      return 'No posts data available';
    }

    const headers = [
      'ID', 'Title', 'Author', 'Platform', 'Date Added', 'Source URL'
    ];

    const rows = posts.map(post => [
      this.escapeCsvValue(post.id),
      this.escapeCsvValue(post.content),
      this.escapeCsvValue(post.authorName),
      post.platform,
      new Date((post.metadata && post.metadata.createTimestamp) ? post.metadata.createTimestamp : Date.now()).toISOString(),
      this.escapeCsvValue(post.sourceUrl || '')
    ]);

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  /**
   * Converts current comments to CSV format
   */
  private convertCurrentCommentsToCSV(comments: any[]): string {
    const headers = [
      'Comment ID', 'Post ID', 'Content', 'Author', 'Publish Date',
      'Like Count', 'Reply Count', 'Parent Comment ID', 'Parent Author Name'
    ];

    const rows = comments.map(comment => [
      this.escapeCsvValue(comment.id),
      this.escapeCsvValue(comment.postId || ''),
      this.escapeCsvValue(comment.content),
      this.escapeCsvValue(comment.authorName),
      new Date(comment.publishTimestamp).toISOString(),
      (comment.likeCount ? comment.likeCount.toString() : '0'),
      (comment.commentCount ? comment.commentCount.toString() : '0'),
      this.escapeCsvValue(comment.parentCommentId || ''),
      this.escapeCsvValue(comment.parentAuthorName || '')
    ]);

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  /**
   * Helper methods for export functionality
   */
  private getDateString(): string {
    return new Date().toISOString().split('T')[0].replace(/-/g, '');
  }

  private escapeCsvValue(value: string | null | undefined): string {
    if (value == null) return '';
    
    const stringValue = value.toString();
    
    if (stringValue.includes(',') || stringValue.includes('"') || 
        stringValue.includes('\n') || stringValue.includes('\r')) {
      return '"' + stringValue.replace(/"/g, '""') + '"';
    }
    
    return stringValue;
  }

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
    }
  }

  private async showSuccessToast(message: string) {
    const toast = await this.toastController.create({
      message: message,
      duration: 3000,
      color: 'success',
      position: 'bottom'
    });
    await toast.present();
  }

  private async showErrorToast(message: string) {
    const toast = await this.toastController.create({
      message: message,
      duration: 3000,
      color: 'danger',
      position: 'bottom'
    });
    await toast.present();
  }
}