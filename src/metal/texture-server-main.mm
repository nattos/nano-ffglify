#import <Foundation/Foundation.h>
#include "texture-server.h"
#include <csignal>
#include <cstdlib>
#include <iostream>

// Forward-declare the WS class (defined in texture-server-ws.mm)
class TextureServerWS {
public:
  TextureServerWS(TextureChannelRegistry &registry, uint16_t port);
  ~TextureServerWS();
  void start();
  void stop();
};

static volatile sig_atomic_t g_running = 1;

static void signalHandler(int sig) {
  g_running = 0;
  CFRunLoopStop(CFRunLoopGetMain());
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    uint16_t port = 9876;
    int expirySeconds = 30;

    // Parse arguments
    for (int i = 1; i < argc; i++) {
      std::string arg = argv[i];
      if (arg == "--port" && i + 1 < argc) {
        port = static_cast<uint16_t>(std::atoi(argv[++i]));
      } else if (arg == "--expiry" && i + 1 < argc) {
        expirySeconds = std::atoi(argv[++i]);
      } else {
        // Positional: treat as port
        port = static_cast<uint16_t>(std::atoi(argv[i]));
      }
    }

    // Set up signal handlers
    signal(SIGTERM, signalHandler);
    signal(SIGINT, signalHandler);

    // Create registry and server
    auto *registry = new TextureChannelRegistry();
    if (expirySeconds != 30) {
      registry->setExpiryDuration(std::chrono::seconds(expirySeconds));
    }

    TextureServerWS server(*registry, port);
    server.start();

    // Set up purge timer (every 5 seconds)
    dispatch_source_t timer = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
        dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0));
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0),
                              5 * NSEC_PER_SEC, 1 * NSEC_PER_SEC);
    dispatch_source_set_event_handler(timer, ^{
      registry->purgeExpired(std::chrono::seconds(expirySeconds));
    });
    dispatch_resume(timer);

    // Run the event loop
    CFRunLoopRun();

    // Cleanup
    dispatch_source_cancel(timer);
    server.stop();
    delete registry;

    return 0;
  }
}
