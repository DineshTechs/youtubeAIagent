export class AIProvider {
  async generateStory({ series, characters, episodeNumber, topic }) {
    throw new Error("AI provider not configured");
  }

  async qualityCheck({ script, rules }) {
    return {
      passed: true,
      issues: [],
      note: "Stub QA provider. Configure an AI provider for production."
    };
  }
}
