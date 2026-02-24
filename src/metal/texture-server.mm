#include "texture-server.h"
#include <algorithm>
#include <cstring>

TextureChannelRegistry::TextureChannelRegistry() {}

void TextureChannelRegistry::pushDebugTexture(const std::string &channel,
                                              int width, int height,
                                              int originalWidth,
                                              int originalHeight,
                                              const std::vector<uint8_t> &rgba) {
  // Upscale the provided data to originalWidth x originalHeight
  TextureData src;
  src.rgba = rgba;
  src.width = width;
  src.height = height;

  TextureData stored;
  if (width != originalWidth || height != originalHeight) {
    stored = upscale(src, originalWidth, originalHeight);
  } else {
    stored = src;
  }

  ChannelInfo info;
  info.name = channel;
  info.width = stored.width;
  info.height = stored.height;
  info.isDebug = true;
  info.lastUpdate = std::chrono::steady_clock::now();

  std::lock_guard<std::mutex> lock(mutex_);
  channels_[channel] = std::move(stored);
  channelInfo_[channel] = std::move(info);
}

bool TextureChannelRegistry::readTexture(const std::string &channel, int maxDim,
                                         TextureData &outData,
                                         ChannelInfo &outInfo) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = channels_.find(channel);
  if (it == channels_.end()) {
    return false;
  }
  auto infoIt = channelInfo_.find(channel);
  if (infoIt == channelInfo_.end()) {
    return false;
  }

  outInfo = infoIt->second;

  if (maxDim > 0 &&
      (it->second.width > maxDim || it->second.height > maxDim)) {
    outData = downscale(it->second, maxDim);
  } else {
    outData = it->second;
  }
  return true;
}

std::vector<ChannelInfo> TextureChannelRegistry::listChannels() const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<ChannelInfo> result;
  result.reserve(channelInfo_.size());
  for (const auto &kv : channelInfo_) {
    result.push_back(kv.second);
  }
  return result;
}

TransportInfo TextureChannelRegistry::getTransport() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return transport_;
}

void TextureChannelRegistry::setTransport(const TransportInfo &info) {
  std::lock_guard<std::mutex> lock(mutex_);
  transport_ = info;
}

void TextureChannelRegistry::purgeExpired(std::chrono::seconds maxAge) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto now = std::chrono::steady_clock::now();
  std::vector<std::string> toRemove;
  for (const auto &kv : channelInfo_) {
    if (kv.second.isDebug) {
      auto elapsed =
          std::chrono::duration_cast<std::chrono::seconds>(now - kv.second.lastUpdate);
      if (elapsed >= maxAge) {
        toRemove.push_back(kv.first);
      }
    }
  }
  for (const auto &key : toRemove) {
    channels_.erase(key);
    channelInfo_.erase(key);
  }
}

void TextureChannelRegistry::setExpiryDuration(std::chrono::seconds duration) {
  std::lock_guard<std::mutex> lock(mutex_);
  expiryDuration_ = duration;
}

// Box-filter downscale to fit within maxDim
TextureData TextureChannelRegistry::downscale(const TextureData &src,
                                              int maxDim) {
  if (maxDim <= 0 || (src.width <= maxDim && src.height <= maxDim)) {
    return src;
  }

  // Calculate scale factor
  float scale =
      static_cast<float>(maxDim) /
      static_cast<float>(std::max(src.width, src.height));
  int dstW = std::max(1, static_cast<int>(src.width * scale));
  int dstH = std::max(1, static_cast<int>(src.height * scale));

  TextureData dst;
  dst.width = dstW;
  dst.height = dstH;
  dst.rgba.resize(dstW * dstH * 4);

  float scaleX = static_cast<float>(src.width) / dstW;
  float scaleY = static_cast<float>(src.height) / dstH;

  for (int dy = 0; dy < dstH; dy++) {
    for (int dx = 0; dx < dstW; dx++) {
      // Source region
      int sx0 = static_cast<int>(dx * scaleX);
      int sy0 = static_cast<int>(dy * scaleY);
      int sx1 = std::min(static_cast<int>((dx + 1) * scaleX), src.width);
      int sy1 = std::min(static_cast<int>((dy + 1) * scaleY), src.height);
      if (sx1 <= sx0) sx1 = sx0 + 1;
      if (sy1 <= sy0) sy1 = sy0 + 1;

      // Average the block
      float r = 0, g = 0, b = 0, a = 0;
      int count = 0;
      for (int sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (int sx = sx0; sx < sx1 && sx < src.width; sx++) {
          int si = (sy * src.width + sx) * 4;
          r += src.rgba[si + 0];
          g += src.rgba[si + 1];
          b += src.rgba[si + 2];
          a += src.rgba[si + 3];
          count++;
        }
      }

      int di = (dy * dstW + dx) * 4;
      dst.rgba[di + 0] = static_cast<uint8_t>(r / count + 0.5f);
      dst.rgba[di + 1] = static_cast<uint8_t>(g / count + 0.5f);
      dst.rgba[di + 2] = static_cast<uint8_t>(b / count + 0.5f);
      dst.rgba[di + 3] = static_cast<uint8_t>(a / count + 0.5f);
    }
  }

  return dst;
}

// Nearest-neighbor upscale
TextureData TextureChannelRegistry::upscale(const TextureData &src, int origW,
                                            int origH) {
  if (src.width == origW && src.height == origH) {
    return src;
  }

  TextureData dst;
  dst.width = origW;
  dst.height = origH;
  dst.rgba.resize(origW * origH * 4);

  for (int dy = 0; dy < origH; dy++) {
    for (int dx = 0; dx < origW; dx++) {
      int sx = dx * src.width / origW;
      int sy = dy * src.height / origH;
      sx = std::min(sx, src.width - 1);
      sy = std::min(sy, src.height - 1);

      int si = (sy * src.width + sx) * 4;
      int di = (dy * origW + dx) * 4;
      dst.rgba[di + 0] = src.rgba[si + 0];
      dst.rgba[di + 1] = src.rgba[si + 1];
      dst.rgba[di + 2] = src.rgba[si + 2];
      dst.rgba[di + 3] = src.rgba[si + 3];
    }
  }

  return dst;
}
