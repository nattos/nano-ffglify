#import <Foundation/Foundation.h>
#import <Network/Network.h>

#include "texture-server.h"
#include <functional>
#include <iostream>
#include <string>

// =====================
// Base64 decode
// =====================

static std::vector<uint8_t> base64Decode(const std::string &encoded) {
  NSData *data = [[NSData alloc]
      initWithBase64EncodedString:
          [NSString stringWithUTF8String:encoded.c_str()]
                          options:
                              NSDataBase64DecodingIgnoreUnknownCharacters];
  if (!data)
    return {};
  const uint8_t *bytes = (const uint8_t *)[data bytes];
  return std::vector<uint8_t>(bytes, bytes + [data length]);
}

static std::string base64Encode(const std::vector<uint8_t> &data) {
  NSData *nsData = [NSData dataWithBytes:data.data() length:data.size()];
  NSString *encoded = [nsData base64EncodedStringWithOptions:0];
  return std::string([encoded UTF8String]);
}

// =====================
// JSON helpers using NSJSONSerialization
// =====================

static NSDictionary *parseJSON(const std::string &str) {
  NSData *data = [NSData dataWithBytes:str.data() length:str.size()];
  NSError *error = nil;
  id obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (error || ![obj isKindOfClass:[NSDictionary class]])
    return nil;
  return (NSDictionary *)obj;
}

static std::string serializeJSON(NSDictionary *dict) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:dict
                                                options:0
                                                  error:&error];
  if (error)
    return "{}";
  return std::string((const char *)[data bytes], [data length]);
}

// =====================
// TextureServerWS
// =====================

class TextureServerWS {
public:
  TextureServerWS(TextureChannelRegistry &registry, uint16_t port);
  ~TextureServerWS();

  void start();
  void stop();
  uint16_t port() const { return port_; }

private:
  void acceptConnection();
  void handleMessage(nw_connection_t conn, const std::string &message);
  void receiveMessage(nw_connection_t conn);
  void sendResponse(nw_connection_t conn, const std::string &json);

  // Method handlers
  NSDictionary *handleDebugReadTexture(NSDictionary *params);
  NSDictionary *handleDebugPushTexture(NSDictionary *params);
  NSDictionary *handleDebugListChannels(NSDictionary *params);
  NSDictionary *handleGetTime(NSDictionary *params);

  TextureChannelRegistry &registry_;
  uint16_t port_;
  nw_listener_t listener_;
  dispatch_queue_t queue_;
};

TextureServerWS::TextureServerWS(TextureChannelRegistry &registry,
                                 uint16_t port)
    : registry_(registry), port_(port), listener_(nil) {
  queue_ = dispatch_queue_create("texture-server-ws", DISPATCH_QUEUE_SERIAL);
}

TextureServerWS::~TextureServerWS() { stop(); }

void TextureServerWS::start() {
  // Create WebSocket protocol options
  nw_parameters_t parameters;
  nw_protocol_options_t ws_options =
      nw_ws_create_options(nw_ws_version_13);

  // Create parameters with WebSocket over TCP
  parameters = nw_parameters_create_secure_tcp(
      NW_PARAMETERS_DISABLE_PROTOCOL, // No TLS
      ^(nw_protocol_options_t tcp_options) {
        // TCP defaults are fine
      });

  // Add WebSocket as application protocol
  nw_protocol_stack_t stack = nw_parameters_copy_default_protocol_stack(parameters);
  nw_protocol_stack_prepend_application_protocol(stack, ws_options);

  // Create listener
  char portStr[8];
  snprintf(portStr, sizeof(portStr), "%u", port_);
  listener_ = nw_listener_create_with_port(portStr, parameters);

  if (!listener_) {
    std::cerr << "Failed to create listener on port " << port_ << std::endl;
    return;
  }

  nw_listener_set_queue(listener_, queue_);

  // Handle new connections
  nw_listener_set_new_connection_handler(listener_,
                                         ^(nw_connection_t connection) {
                                           nw_connection_set_queue(connection,
                                                                   queue_);

                                           nw_connection_set_state_changed_handler(
                                               connection,
                                               ^(nw_connection_state_t state,
                                                 nw_error_t error) {
                                                 if (state ==
                                                     nw_connection_state_ready) {
                                                   receiveMessage(connection);
                                                 }
                                               });

                                           nw_connection_start(connection);
                                         });

  // Handle listener state changes
  nw_listener_set_state_changed_handler(
      listener_, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) {
          // Print readiness signal to stdout
          uint16_t actualPort = nw_listener_get_port(listener_);
          fprintf(stdout, "{\"status\":\"listening\",\"port\":%u}\n",
                  actualPort);
          fflush(stdout);
        } else if (state == nw_listener_state_failed) {
          if (error) {
            std::cerr << "Listener failed: "
                      << nw_error_get_error_code(error) << std::endl;
          }
        }
      });

  nw_listener_start(listener_);
}

void TextureServerWS::stop() {
  if (listener_) {
    nw_listener_cancel(listener_);
    listener_ = nil;
  }
}

void TextureServerWS::receiveMessage(nw_connection_t conn) {
  nw_connection_receive_message(
      conn, ^(dispatch_data_t content, nw_content_context_t context,
              bool is_complete, nw_error_t error) {
        if (error) {
          return;
        }

        if (content) {
          // Extract string from dispatch_data
          __block std::string message;
          dispatch_data_apply(
              content, ^bool(dispatch_data_t region, size_t offset,
                             const void *buffer, size_t size) {
                message.append((const char *)buffer, size);
                return true;
              });

          handleMessage(conn, message);
        }

        // Continue receiving messages
        if (!error && !is_complete) {
          receiveMessage(conn);
        } else if (is_complete && content) {
          // WebSocket message complete, wait for next
          receiveMessage(conn);
        }
      });
}

void TextureServerWS::handleMessage(nw_connection_t conn,
                                    const std::string &message) {
  NSDictionary *request = parseJSON(message);
  if (!request) {
    sendResponse(conn, serializeJSON(@{
                   @"error" : @{@"code" : @400, @"message" : @"Invalid JSON"}
                 }));
    return;
  }

  NSString *requestId = request[@"id"];
  NSString *method = request[@"method"];
  NSDictionary *params = request[@"params"];
  if (!params)
    params = @{};

  if (!method) {
    NSMutableDictionary *resp = [NSMutableDictionary dictionary];
    if (requestId)
      resp[@"id"] = requestId;
    resp[@"error"] =
        @{@"code" : @400, @"message" : @"Missing 'method' field"};
    sendResponse(conn, serializeJSON(resp));
    return;
  }

  NSDictionary *result = nil;
  NSDictionary *errorDict = nil;

  std::string methodStr = [method UTF8String];
  if (methodStr == "debug_read_texture") {
    result = handleDebugReadTexture(params);
  } else if (methodStr == "debug_push_texture") {
    result = handleDebugPushTexture(params);
  } else if (methodStr == "debug_list_channels") {
    result = handleDebugListChannels(params);
  } else if (methodStr == "get_time") {
    result = handleGetTime(params);
  } else {
    errorDict = @{
      @"code" : @404,
      @"message" :
          [NSString stringWithFormat:@"Unknown method: %@", method]
    };
  }

  // Check if result itself is an error
  if (result && result[@"__error"]) {
    errorDict = @{
      @"code" : result[@"__error_code"],
      @"message" : result[@"__error"]
    };
    result = nil;
  }

  NSMutableDictionary *response = [NSMutableDictionary dictionary];
  if (requestId)
    response[@"id"] = requestId;
  if (result)
    response[@"result"] = result;
  if (errorDict)
    response[@"error"] = errorDict;

  sendResponse(conn, serializeJSON(response));
}

void TextureServerWS::sendResponse(nw_connection_t conn,
                                   const std::string &json) {
  NSData *data = [NSData dataWithBytes:json.data() length:json.size()];
  dispatch_data_t dispatchData = dispatch_data_create(
      [data bytes], [data length], queue_, DISPATCH_DATA_DESTRUCTOR_DEFAULT);

  // Create WebSocket metadata for text message
  nw_protocol_metadata_t metadata =
      nw_ws_create_metadata(nw_ws_opcode_text);
  nw_content_context_t context =
      nw_content_context_create("ws-response");
  nw_content_context_set_metadata_for_protocol(context, metadata);

  nw_connection_send(conn, dispatchData, context, true,
                     ^(nw_error_t error) {
                       if (error) {
                         std::cerr << "Send error: "
                                   << nw_error_get_error_code(error)
                                   << std::endl;
                       }
                     });
}

// =====================
// Method handlers
// =====================

NSDictionary *
TextureServerWS::handleDebugReadTexture(NSDictionary *params) {
  NSString *channel = params[@"channel"];
  if (!channel) {
    return @{
      @"__error" : @"Missing 'channel' parameter",
      @"__error_code" : @400
    };
  }

  int maxDim = 0;
  if (params[@"maxDim"]) {
    maxDim = [params[@"maxDim"] intValue];
  }

  TextureData data;
  ChannelInfo info;
  std::string channelStr = [channel UTF8String];
  if (!registry_.readTexture(channelStr, maxDim, data, info)) {
    return @{
      @"__error" : @"Channel not found",
      @"__error_code" : @404
    };
  }

  std::string b64 = base64Encode(data.rgba);

  return @{
    @"channel" : channel,
    @"width" : @(info.width),
    @"height" : @(info.height),
    @"thumbWidth" : @(data.width),
    @"thumbHeight" : @(data.height),
    @"isDebug" : @(info.isDebug),
    @"data" : [NSString stringWithUTF8String:b64.c_str()]
  };
}

NSDictionary *
TextureServerWS::handleDebugPushTexture(NSDictionary *params) {
  NSString *channel = params[@"channel"];
  NSNumber *width = params[@"width"];
  NSNumber *height = params[@"height"];
  NSNumber *originalWidth = params[@"originalWidth"];
  NSNumber *originalHeight = params[@"originalHeight"];
  NSString *dataStr = params[@"data"];

  if (!channel || !width || !height || !dataStr) {
    return @{
      @"__error" : @"Missing required parameters",
      @"__error_code" : @400
    };
  }

  int w = [width intValue];
  int h = [height intValue];
  int origW = originalWidth ? [originalWidth intValue] : w;
  int origH = originalHeight ? [originalHeight intValue] : h;

  std::vector<uint8_t> rgba = base64Decode([dataStr UTF8String]);
  if (rgba.size() != (size_t)(w * h * 4)) {
    return @{
      @"__error" : @"Data size mismatch",
      @"__error_code" : @400
    };
  }

  registry_.pushDebugTexture([channel UTF8String], w, h, origW, origH,
                             rgba);
  return @{@"ok" : @YES};
}

NSDictionary *
TextureServerWS::handleDebugListChannels(NSDictionary *params) {
  auto channels = registry_.listChannels();
  NSMutableArray *arr = [NSMutableArray arrayWithCapacity:channels.size()];

  auto now = std::chrono::steady_clock::now();
  for (const auto &ch : channels) {
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        now - ch.lastUpdate);
    // Calculate expiry (30s default for debug channels)
    int64_t expiresInMs = ch.isDebug ? std::max((int64_t)0, (int64_t)30000 - elapsed.count()) : -1;

    NSMutableDictionary *entry = [NSMutableDictionary dictionary];
    entry[@"name"] = [NSString stringWithUTF8String:ch.name.c_str()];
    entry[@"width"] = @(ch.width);
    entry[@"height"] = @(ch.height);
    entry[@"isDebug"] = @(ch.isDebug);
    if (ch.isDebug) {
      entry[@"expiresInMs"] = @(expiresInMs);
    }
    [arr addObject:entry];
  }

  return @{@"channels" : arr};
}

NSDictionary *TextureServerWS::handleGetTime(NSDictionary *params) {
  auto t = registry_.getTransport();
  return @{
    @"frameNumber" : @(t.frameNumber),
    @"bpm" : @(t.bpm),
    @"phase" : @(t.phase),
    @"timeSeconds" : @(t.timeSeconds)
  };
}
