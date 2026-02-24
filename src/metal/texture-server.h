#pragma once

#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// =====================
// Data structures
// =====================

struct TextureData {
  std::vector<uint8_t> rgba; // RGBA8, row-major
  int width = 0;
  int height = 0;
};

struct ChannelInfo {
  std::string name;
  int width = 0;
  int height = 0;
  bool isDebug = false;
  std::chrono::steady_clock::time_point lastUpdate;
};

struct TransportInfo {
  uint64_t frameNumber = 0;
  double bpm = 120.0;
  double phase = 0.0;
  double timeSeconds = 0.0;
};

// =====================
// TextureChannelRegistry
// =====================

class TextureChannelRegistry {
public:
  TextureChannelRegistry();

  // Channel CRUD
  void pushDebugTexture(const std::string &channel, int width, int height,
                        int originalWidth, int originalHeight,
                        const std::vector<uint8_t> &rgba);

  // Returns false if channel not found
  bool readTexture(const std::string &channel, int maxDim,
                   TextureData &outData, ChannelInfo &outInfo) const;

  std::vector<ChannelInfo> listChannels() const;

  // Transport
  TransportInfo getTransport() const;
  void setTransport(const TransportInfo &info);

  // Expiry: remove debug channels older than `maxAge`
  void purgeExpired(std::chrono::seconds maxAge);

  // For testing: set a custom expiry duration checked in purge
  void setExpiryDuration(std::chrono::seconds duration);

private:
  // Box-filter downscale to fit within maxDim
  static TextureData downscale(const TextureData &src, int maxDim);
  // Nearest-neighbor upscale from (width x height) to (origW x origH)
  static TextureData upscale(const TextureData &src, int origW, int origH);

  mutable std::mutex mutex_;
  std::unordered_map<std::string, TextureData> channels_;
  std::unordered_map<std::string, ChannelInfo> channelInfo_;
  TransportInfo transport_;
  std::chrono::seconds expiryDuration_{30};
};
