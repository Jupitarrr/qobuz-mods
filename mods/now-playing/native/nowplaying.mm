// Qobuz macOS mod: publish MPNowPlayingInfoCenter metadata and handle
// MPRemoteCommandCenter commands from inside the Qobuz Electron main process.
//
// This is intentionally a Node N-API addon rather than a helper process: the
// Now Playing session then belongs to the Qobuz app itself (icon, app name,
// permissions) instead of to a faceless bridge app.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <MediaPlayer/MediaPlayer.h>

#include <node_api.h>

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

napi_threadsafe_function g_command_tsfn = nullptr;
NSString *g_artwork_path = nil;

void CallJsCommand(napi_env env, napi_value js_cb, void * /*context*/, void *data) {
  char *command = static_cast<char *>(data);
  if (env != nullptr && js_cb != nullptr && command != nullptr) {
    napi_value global;
    napi_value arg;
    if (napi_get_global(env, &global) == napi_ok &&
        napi_create_string_utf8(env, command, NAPI_AUTO_LENGTH, &arg) == napi_ok) {
      napi_call_function(env, global, js_cb, 1, &arg, nullptr);
    }
  }
  std::free(command);
}

void SendCommand(NSString *name) {
  if (g_command_tsfn == nullptr || name == nil) {
    return;
  }
  NSLog(@"[qobuz-mod] MPRemoteCommandCenter command: %@", name);
  const char *utf8 = [name UTF8String];
  if (utf8 == nullptr) {
    return;
  }
  char *copy = strdup(utf8);
  if (copy == nullptr) {
    return;
  }
  if (napi_call_threadsafe_function(g_command_tsfn, copy, napi_tsfn_nonblocking) != napi_ok) {
    std::free(copy);
  }
}

void RegisterRemoteCommands() {
  MPRemoteCommandCenter *center = [MPRemoteCommandCenter sharedCommandCenter];

  void (^add)(MPRemoteCommand *, NSString *) = ^(MPRemoteCommand *command, NSString *name) {
    command.enabled = YES;
    [command addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *_Nonnull event) {
      (void)event;
      SendCommand(name);
      return MPRemoteCommandHandlerStatusSuccess;
    }];
  };

  add(center.playCommand, @"play");
  add(center.pauseCommand, @"pause");
  add(center.togglePlayPauseCommand, @"toggle");
  add(center.nextTrackCommand, @"next");
  add(center.previousTrackCommand, @"previous");
  NSLog(@"[qobuz-mod] MPRemoteCommandCenter handlers registered");
}

bool GetNamedProperty(napi_env env, napi_value object, const char *key, napi_value *out) {
  bool has = false;
  if (napi_has_named_property(env, object, key, &has) != napi_ok || !has) {
    return false;
  }
  return napi_get_named_property(env, object, key, out) == napi_ok;
}

std::string GetString(napi_env env, napi_value object, const char *key) {
  napi_value value;
  if (!GetNamedProperty(env, object, key, &value)) {
    return {};
  }
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    return {};
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return {};
  }
  std::vector<char> buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return {};
  }
  return std::string(buffer.data(), length);
}

double GetNumber(napi_env env, napi_value object, const char *key, double fallback) {
  napi_value value;
  if (!GetNamedProperty(env, object, key, &value)) {
    return fallback;
  }
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) {
    return fallback;
  }
  double result = fallback;
  if (napi_get_value_double(env, value, &result) != napi_ok) {
    return fallback;
  }
  return result;
}

void SetPlaybackState(NSString *state) {
  MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
  if ([state isEqualToString:@"playing"]) {
    center.playbackState = MPNowPlayingPlaybackStatePlaying;
  } else if ([state isEqualToString:@"paused"]) {
    center.playbackState = MPNowPlayingPlaybackStatePaused;
  } else if ([state isEqualToString:@"stopped"]) {
    center.playbackState = MPNowPlayingPlaybackStateStopped;
  }
}

MPMediaItemArtwork *LoadArtwork(NSString *path) {
  if (path == nil || path.length == 0) {
    return nil;
  }
  if (g_artwork_path != nil && [g_artwork_path isEqualToString:path]) {
    id existing = [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo[MPMediaItemPropertyArtwork];
    if (existing != nil) {
      return existing;
    }
  }

  NSImage *image = nil;
  if ([path hasPrefix:@"file://"]) {
    image = [[NSImage alloc] initWithContentsOfURL:[NSURL URLWithString:path]];
  } else {
    image = [[NSImage alloc] initWithContentsOfFile:path];
  }
  if (image == nil) {
    return nil;
  }

  g_artwork_path = [path copy];
  return [[MPMediaItemArtwork alloc] initWithBoundsSize:image.size
                                         requestHandler:^NSImage *_Nonnull(CGSize size) {
                                           (void)size;
                                           return image;
                                         }];
}

napi_value InitAddon(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    napi_throw_type_error(env, nullptr, "init(callback) requires a command callback");
    return nullptr;
  }

  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "init(callback) requires a function");
    return nullptr;
  }

  if (g_command_tsfn != nullptr) {
    napi_release_threadsafe_function(g_command_tsfn, napi_tsfn_abort);
    g_command_tsfn = nullptr;
  }

  napi_value resource_name;
  napi_create_string_utf8(env, "QobuzNowPlayingCommand", NAPI_AUTO_LENGTH, &resource_name);
  napi_status status = napi_create_threadsafe_function(
      env, argv[0], nullptr, resource_name, 0, 1, nullptr, nullptr, nullptr, CallJsCommand,
      &g_command_tsfn);
  if (status != napi_ok) {
    g_command_tsfn = nullptr;
    napi_throw_error(env, nullptr, "could not create command thread-safe function");
    return nullptr;
  }

  // Do not keep the Node event loop alive merely because this addon exists.
  napi_unref_threadsafe_function(env, g_command_tsfn);

  RegisterRemoteCommands();
  return nullptr;
}

napi_value SetTrack(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    return nullptr;
  }

  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object) {
    return nullptr;
  }

  @autoreleasepool {
    NSString *title = @(GetString(env, argv[0], "title").c_str());
    NSString *artist = @(GetString(env, argv[0], "artist").c_str());
    NSString *album = @(GetString(env, argv[0], "album").c_str());
    NSString *state = @(GetString(env, argv[0], "state").c_str());
    NSString *artwork_path = @(GetString(env, argv[0], "artworkPath").c_str());
    double duration = GetNumber(env, argv[0], "duration", 0.0);
    double elapsed = GetNumber(env, argv[0], "elapsed", 0.0);
    double rate = GetNumber(env, argv[0], "rate", 0.0);

    NSMutableDictionary *now = [NSMutableDictionary dictionary];
    now[MPNowPlayingInfoPropertyMediaType] = @(MPNowPlayingInfoMediaTypeAudio);
    now[MPNowPlayingInfoPropertyDefaultPlaybackRate] = @(1.0);
    if (title.length > 0) {
      now[MPMediaItemPropertyTitle] = title;
    }
    if (artist.length > 0) {
      now[MPMediaItemPropertyArtist] = artist;
    }
    if (album.length > 0) {
      now[MPMediaItemPropertyAlbumTitle] = album;
    }
    if (duration > 0.0) {
      now[MPMediaItemPropertyPlaybackDuration] = @(duration);
    }
    if (elapsed >= 0.0) {
      now[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(elapsed);
    }
    now[MPNowPlayingInfoPropertyPlaybackRate] = @(rate);

    MPMediaItemArtwork *artwork = LoadArtwork(artwork_path);
    if (artwork != nil) {
      now[MPMediaItemPropertyArtwork] = artwork;
    } else if (artwork_path.length == 0) {
      g_artwork_path = nil;
    }

    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = now;
    SetPlaybackState(state);
  }

  return nullptr;
}

napi_value SetProgress(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    return nullptr;
  }

  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object) {
    return nullptr;
  }

  @autoreleasepool {
    double elapsed = GetNumber(env, argv[0], "elapsed", -1.0);
    double duration = GetNumber(env, argv[0], "duration", -1.0);
    double rate = GetNumber(env, argv[0], "rate", -1.0);
    NSString *state = @(GetString(env, argv[0], "state").c_str());

    NSMutableDictionary *now =
        [NSMutableDictionary dictionaryWithDictionary:[MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo ?: @{}];
    if (elapsed >= 0.0) {
      now[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(elapsed);
    }
    if (duration > 0.0) {
      now[MPMediaItemPropertyPlaybackDuration] = @(duration);
    }
    if (rate >= 0.0) {
      now[MPNowPlayingInfoPropertyPlaybackRate] = @(rate);
    }
    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = now;
    SetPlaybackState(state);
  }

  return nullptr;
}

napi_value SetState(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    return nullptr;
  }

  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object) {
    return nullptr;
  }

  @autoreleasepool {
    NSString *state = @(GetString(env, argv[0], "state").c_str());
    double rate = GetNumber(env, argv[0], "rate", -1.0);

    NSMutableDictionary *now =
        [NSMutableDictionary dictionaryWithDictionary:[MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo ?: @{}];
    if (rate >= 0.0) {
      now[MPNowPlayingInfoPropertyPlaybackRate] = @(rate);
    }
    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = now;
    SetPlaybackState(state);
  }

  return nullptr;
}

napi_value Clear(napi_env env, napi_callback_info /*info*/) {
  (void)env;
  @autoreleasepool {
    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = @{};
    [MPNowPlayingInfoCenter defaultCenter].playbackState = MPNowPlayingPlaybackStateStopped;
    g_artwork_path = nil;
  }
  return nullptr;
}

napi_value TerminateVendor(napi_env env, napi_callback_info /*info*/) {
  @autoreleasepool {
    NSArray<NSRunningApplication *> *apps =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.qobuz.desktop"];
    napi_value result;
    napi_create_array(env, &result);

    uint32_t index = 0;
    pid_t self = getpid();
    for (NSRunningApplication *app in apps) {
      if (app.processIdentifier == self) {
        continue;
      }
      [app terminate];
      napi_value pid;
      napi_create_int32(env, app.processIdentifier, &pid);
      napi_set_element(env, result, index++, pid);
    }
    return result;
  }
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"init", nullptr, InitAddon, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setTrack", nullptr, SetTrack, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setProgress", nullptr, SetProgress, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setState", nullptr, SetState, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"clear", nullptr, Clear, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminateVendor", nullptr, TerminateVendor, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
