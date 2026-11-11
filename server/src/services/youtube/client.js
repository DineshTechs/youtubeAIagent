export class YouTubeClient {
  constructor() {
    this.enabled = false;
  }

  async upload() {
    throw new Error("YouTube OAuth client is not configured yet");
  }

  async schedule() {
    throw new Error("YouTube OAuth client is not configured yet");
  }
}

export const youtubeClient = new YouTubeClient();
