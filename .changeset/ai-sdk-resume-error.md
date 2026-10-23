---
"agents": patch
---

Fixed a failed stream resume raising the internal core `CloudflareAIError` instead of the exported AI SDK one: errors thrown while a streamed `/run` answer is read are now lifted with `toAISDKError`, so `instanceof CloudflareAIError` and `APICallError.isInstance` work for resume failures as documented.
