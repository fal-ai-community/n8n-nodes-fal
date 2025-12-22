# n8n-nodes-fal-ai

This is an n8n community node for [fal.ai](https://fal.ai) - access hundreds of AI models for image generation, video generation, text-to-speech, and more.

## Features

- **Generate Media**: Create images, videos, audio using any fal.ai model
- **Dynamic Parameters**: Auto-loads model-specific parameters
- **Usage Statistics**: Monitor your fal.ai usage and costs (Admin Key required)
- **Payload Management**: Delete request payloads to manage storage (Admin Key required)
- **Model Discovery**: Search hundreds of available models

## Installation

### Via n8n Community Nodes

1. Open n8n **Settings** > **Community Nodes**
2. Click **Install**
3. Enter `n8n-nodes-fal-ai`
4. Install

### Manual Installation

```bash
cd ~/.n8n
npm install n8n-nodes-fal-ai
```

## Credentials Setup

1. Get your API key from [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys)
2. In n8n, create **fal.ai API** credentials
3. Enter your API key

⚠️ **Important**: Use an **Admin API Key** for Get Usage and Delete Payloads operations.

## Operations

### Generate Media

Generate images, videos, or audio using any fal.ai model.

- Select a model from the list or enter model ID
- Add dynamic parameters (automatically loaded from model schema)
- Configure wait time and polling options

### Get Model Info

Retrieve detailed information about a model's parameters and capabilities.

### Get Usage ⚠️ Admin Key Required

Monitor your workspace usage and costs:
- Filter by model or see all models
- Select time range (30min, 1hr, 24hr, 7d, 30d, custom)
- View detailed billing information

### Delete Request Payloads ⚠️ Admin Key Required

Delete request payloads and associated CDN files to manage storage costs.

## Quick Examples

### Image Generation (FLUX)
```
Model: fal-ai/flux/dev
Parameters:
  - prompt: "A serene Japanese garden"
  - num_images: 1
```

### Video from Image (Kling)
```
Model: fal-ai/kling-video/v1.6/pro/image-to-video
Parameters:
  - image_url: "https://example.com/image.jpg"
  - duration: "5"
```

### Usage Monitoring
```
Operation: Get Usage
Time Range: Last 24 Hours
Model: fal-ai/flux/dev (optional)
```

## API Key Types

| Operation | Regular Key | Admin Key |
|-----------|-------------|-----------|
| Generate Media | ✅ | ✅ |
| Get Model Info | ✅ | ✅ |
| Get Usage | ❌ | ✅ |
| Delete Payloads | ❌ | ✅ |

## Resources

- [fal.ai Documentation](https://fal.ai/docs)
- [Model Gallery](https://fal.ai/models)
- [API Keys Dashboard](https://fal.ai/dashboard/keys)

## License

MIT
