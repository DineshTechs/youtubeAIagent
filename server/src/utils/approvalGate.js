// Approval requirements are independent of the QA report version. Earlier
// builds used a hard-coded version allow-list, so every newer QA version
// silently skipped the technical-QA and human visual-review requirements.
export function approvalBlockReason(video) {
  if (!video) return 'Video not found.';
  const qa = video.qa;
  if (!qa || !Array.isArray(qa.checks)) {
    return 'No technical QA report is available. Run QA again before approval.';
  }
  if (qa.pass !== true) {
    return 'Technical QA has failed. Run QA again or fix the reported issues before approval.';
  }
  const review = video.visualReview || {};
  if (!(review.imagesMatch === true && review.subtitlesReadable === true && review.ageAppropriate === true)) {
    return 'Complete all three visual review checks before approving this video.';
  }
  return null;
}
