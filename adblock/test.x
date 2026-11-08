
// test.x
// 可配置的 URL 广告拦截 / 观察器
//
// 设计目标：
//   1. App 启动即生效；
//   2. 黑名单模式 / 白名单模式；
//   3. 观察者模式：只记录域名，不拦截；
//   4. 关网开关：临时阻断当前 App 所有 http/https 请求，用于判断广告是否来自远端；
//   5. 启动后 30 秒内三指双击打开设置（覆盖较长的开屏广告）；
//   6. 配置本地保存，重启 App 后从启动阶段开始拦截。
//
// 说明：
//   - 本文件是 Logos/Tweak 源码，需要 Theos 或兼容的 Logos 构建环境；
//   - 只处理 http/https，不处理 file/data/about 等本地 URL；
//   - 只记录域名，不记录完整 URL 和查询参数。
//
// 已知边界：
//   - WKWebView 的子资源请求可能发生在独立进程，URL hook 不一定能覆盖；
//   - 已经缓存在本地的广告可能仍会显示，URL 拦截只针对网络请求；
//   - 使用自定义网络栈、CFNetwork 或私有协议的实现可能绕过；
//   - 白名单严格模式会拦截所有未列出的 http/https 请求，可能影响 App 正常功能。

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <dispatch/dispatch.h>

// ============================================================
// 常量
// ============================================================

static NSString *const kABEnabledKey            = @"AB_enabled";
static NSString *const kABBlockAllKey           = @"AB_block_all";
static NSString *const kABObserverKey           = @"AB_observer";
static NSString *const kABWhitelistExceptionKey = @"AB_whitelist_exception";
static NSString *const kABModeKey               = @"AB_mode";
static NSString *const kABBlacklistKey          = @"AB_blacklist";
static NSString *const kABWhitelistKey          = @"AB_whitelist";
static NSString *const kABOverlayAlphaKey       = @"AB_overlay_alpha";
static NSString *const kABOverlayCenterXKey     = @"AB_overlay_center_x";
static NSString *const kABOverlayCenterYKey     = @"AB_overlay_center_y";

static NSString *const kABBlockedURL            = @"http://127.0.0.1:1/__adblock_blocked__";
static NSString *const kABBlockedURLPrefix      = @"http://127.0.0.1:1/__adblock_blocked__";

static const NSInteger kABMaxLogEntries         = 300;
static const NSTimeInterval kABGestureWindow    = 30.0;
static const NSTimeInterval kABOverlayDuration  = 5.0;
static const CGFloat kABOverlayDefaultAlpha     = 0.6;
static const CGFloat kABOverlayButtonWidth      = 96.0;
static const CGFloat kABOverlayButtonHeight     = 44.0;
static const CGFloat kABOverlayEdgeMargin       = 24.0;
static const CGFloat kABOverlayBottomExtra      = 34.0;
static const CGFloat kABOverlayTopExtra         = 70.0;
static const CGFloat kABOverlayDragMargin       = 8.0;

typedef NS_ENUM(NSInteger, ABMode) {
    ABModeBlacklist = 0,
    ABModeWhitelist = 1
};

// ============================================================
// 前向声明
// ============================================================

@class ABSettingsViewController;
@class ABLogViewController;

@interface ABSettingsPresenter : NSObject
+ (BOOL)presentNow;
+ (void)dismiss;
@end

// ============================================================
// 工具：URL / 域名
// ============================================================

static BOOL ABSIsSentinelURLString(NSString *s)
{
    return [s isKindOfClass:[NSString class]] &&
           [s hasPrefix:kABBlockedURLPrefix];
}

static NSString *ABTrim(NSString *s)
{
    if (![s isKindOfClass:[NSString class]]) {
        return nil;
    }
    return [s stringByTrimmingCharactersInSet:
            [NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

// 只解析 http/https 的 host。
// 非 http/https、相对 URL、无法识别的内容返回 nil。
static NSString *ABHostFromURLString(NSString *s)
{
    if (![s isKindOfClass:[NSString class]] || s.length == 0) {
        return nil;
    }

    NSRange schemeRange = [s rangeOfString:@"://"];
    if (schemeRange.location == NSNotFound) {
        return nil;
    }

    NSString *scheme = [[s substringToIndex:schemeRange.location] lowercaseString];
    if (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) {
        return nil;
    }

    NSUInteger start = NSMaxRange(schemeRange);
    if (start >= s.length) {
        return nil;
    }

    NSCharacterSet *delims = [NSCharacterSet characterSetWithCharactersInString:@"/?#"];
    NSRange stop = [s rangeOfCharacterFromSet:delims
                                      options:0
                                        range:NSMakeRange(start, s.length - start)];
    NSUInteger end = (stop.location == NSNotFound) ? s.length : stop.location;

    NSString *authority = [s substringWithRange:NSMakeRange(start, end - start)];
    authority = ABTrim(authority);
    if (authority.length == 0) {
        return nil;
    }

    // 去掉 userinfo
    NSRange at = [authority rangeOfString:@"@" options:NSBackwardsSearch];
    if (at.location != NSNotFound) {
        authority = [authority substringFromIndex:NSMaxRange(at)];
    }

    // IPv6: [::1]:443
    if ([authority hasPrefix:@"["]) {
        NSRange close = [authority rangeOfString:@"]"];
        if (close.location == NSNotFound) {
            return nil;
        }
        authority = [authority substringWithRange:NSMakeRange(1, close.location - 1)];
    } else {
        // 去掉端口
        NSRange colon = [authority rangeOfString:@":" options:NSBackwardsSearch];
        if (colon.location != NSNotFound) {
            authority = [authority substringToIndex:colon.location];
        }
    }

    authority = [authority lowercaseString];
    if ([authority hasSuffix:@"."]) {
        authority = [authority substringToIndex:authority.length - 1];
    }

    return authority.length ? authority : nil;
}

// 把用户输入整理成关键词：
//   - 如果粘贴的是完整 URL，自动取 host；
//   - 去掉开头的 *.；
//   - 统一小写。
static NSString *ABNormalizeKeyword(NSString *input)
{
    NSString *s = ABTrim(input);
    if (s.length == 0) {
        return nil;
    }

    NSString *host = ABHostFromURLString(s);
    if (host.length) {
        s = host;
    }

    s = [s lowercaseString];

    if ([s hasPrefix:@"*."]) {
        s = [s substringFromIndex:2];
    }
    if ([s hasSuffix:@"."]) {
        s = [s substringToIndex:s.length - 1];
    }

    return s.length ? s : nil;
}

// 匹配规则：
//   1. 带点的关键词按域名后缀匹配：
//        toutiao.com 匹配 toutiao.com、ads.toutiao.com，
//        不匹配 nottoutiao.com；
//   2. 不带点的关键词按“包含”匹配：
//        toutiao 匹配 pglstatp-toutiao.com；
//   3. 支持 *.example.com。
static BOOL ABHostMatchesKeyword(NSString *host, NSString *keyword)
{
    if (host.length == 0 || keyword.length == 0) {
        return NO;
    }

    NSString *kw = [keyword lowercaseString];

    if ([kw hasPrefix:@"*."]) {
        NSString *base = [kw substringFromIndex:2];
        if (base.length == 0) {
            return NO;
        }
        return [host isEqualToString:base] ||
               [host hasSuffix:[@"." stringByAppendingString:base]];
    }

    if ([kw rangeOfString:@"."].location != NSNotFound) {
        return [host isEqualToString:kw] ||
               [host hasSuffix:[@"." stringByAppendingString:kw]];
    }

    return [host rangeOfString:kw].location != NSNotFound;
}

static BOOL ABHostMatchesAny(NSString *host, NSArray<NSString *> *keywords)
{
    if (host.length == 0 || keywords.count == 0) {
        return NO;
    }

    for (NSString *kw in keywords) {
        if (ABHostMatchesKeyword(host, kw)) {
            return YES;
        }
    }
    return NO;
}

// ============================================================
// 配置
// ============================================================

static NSArray<NSString *> *ABDefaultBlacklist(void)
{
    // 默认只是一组常见广告/统计关键词。
    // 用户可以在设置里增删；不保证对所有 App 都准确。
    return @[
        @"gdt.qq",
        @"pglstatp-toutiao.com",
        @"pinduoduo",
        @"pgdt.ugdtimg.com",
        @"qubiankeji",
        @"toutiao.com",
        @"pangolin-sdk-toutiao-b",
        @"meituan",
        @"umeng",
        @"kuaishou",
        @"ugdtimg",
        @"zijieapi",
        @"tianmu",
        @"admobile",
        @"getAppStartAdvertise",
        @"advertise"
    ];
}

@interface ABConfig : NSObject

@property (atomic, assign) BOOL enabled;
@property (atomic, assign) BOOL blockAll;
@property (atomic, assign) BOOL observer;
@property (atomic, assign) BOOL whitelistException;
@property (atomic, assign) NSInteger mode;
@property (atomic, assign) CGFloat overlayAlpha;
@property (atomic, assign) CGFloat overlayCenterX;
@property (atomic, assign) CGFloat overlayCenterY;
@property (atomic, copy)   NSArray<NSString *> *blacklist;
@property (atomic, copy)   NSArray<NSString *> *whitelist;

+ (instancetype)shared;

- (void)load;
- (void)save;
- (void)resetDefaults;
- (void)addKeyword:(NSString *)keyword blacklist:(BOOL)blacklist;
- (void)removeKeywordAtIndex:(NSInteger)index blacklist:(BOOL)blacklist;
- (NSArray<NSString *> *)blacklistSnapshot;
- (NSArray<NSString *> *)whitelistSnapshot;

@end

@implementation ABConfig

+ (instancetype)shared
{
    static ABConfig *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[ABConfig alloc] init];
        [instance load];
    });
    return instance;
}

- (void)load
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];

    if ([d objectForKey:kABEnabledKey]) {
        self.enabled = [d boolForKey:kABEnabledKey];
    } else {
        self.enabled = YES;
    }

    self.blockAll = [d boolForKey:kABBlockAllKey];
    self.observer = [d boolForKey:kABObserverKey];

    if ([d objectForKey:kABWhitelistExceptionKey]) {
        self.whitelistException = [d boolForKey:kABWhitelistExceptionKey];
    } else {
        self.whitelistException = YES;
    }

    self.mode = [d integerForKey:kABModeKey];

    if ([d objectForKey:kABOverlayAlphaKey]) {
        self.overlayAlpha = [d doubleForKey:kABOverlayAlphaKey];
    } else {
        self.overlayAlpha = kABOverlayDefaultAlpha;
    }
    if (self.overlayAlpha < 0.1) {
        self.overlayAlpha = 0.1;
    } else if (self.overlayAlpha > 1.0) {
        self.overlayAlpha = 1.0;
    }

    if ([d objectForKey:kABOverlayCenterXKey] &&
        [d objectForKey:kABOverlayCenterYKey]) {
        self.overlayCenterX = [d doubleForKey:kABOverlayCenterXKey];
        self.overlayCenterY = [d doubleForKey:kABOverlayCenterYKey];
        if (self.overlayCenterX < 0.0 || self.overlayCenterX > 1.0 ||
            self.overlayCenterY < 0.0 || self.overlayCenterY > 1.0) {
            self.overlayCenterX = -1.0;
            self.overlayCenterY = -1.0;
        }
    } else {
        self.overlayCenterX = -1.0;
        self.overlayCenterY = -1.0;
    }

    NSArray *black = [d arrayForKey:kABBlacklistKey];
    NSArray *white = [d arrayForKey:kABWhitelistKey];

    self.blacklist = black ?: ABDefaultBlacklist();
    self.whitelist = white ?: @[];
}

- (void)save
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];

    [d setBool:self.enabled forKey:kABEnabledKey];
    [d setBool:self.blockAll forKey:kABBlockAllKey];
    [d setBool:self.observer forKey:kABObserverKey];
    [d setBool:self.whitelistException forKey:kABWhitelistExceptionKey];
    [d setInteger:self.mode forKey:kABModeKey];
    [d setDouble:self.overlayAlpha forKey:kABOverlayAlphaKey];
    [d setDouble:self.overlayCenterX forKey:kABOverlayCenterXKey];
    [d setDouble:self.overlayCenterY forKey:kABOverlayCenterYKey];
    [d setObject:self.blacklist forKey:kABBlacklistKey];
    [d setObject:self.whitelist forKey:kABWhitelistKey];
    [d synchronize];
}

- (void)resetDefaults
{
    self.enabled = YES;
    self.blockAll = NO;
    self.observer = NO;
    self.whitelistException = YES;
    self.mode = ABModeBlacklist;
    self.overlayAlpha = kABOverlayDefaultAlpha;
    self.overlayCenterX = -1.0;
    self.overlayCenterY = -1.0;
    self.blacklist = ABDefaultBlacklist();
    self.whitelist = @[];
    [self save];
}

- (NSArray<NSString *> *)blacklistSnapshot
{
    return [self.blacklist copy] ?: @[];
}

- (NSArray<NSString *> *)whitelistSnapshot
{
    return [self.whitelist copy] ?: @[];
}

- (void)addKeyword:(NSString *)keyword blacklist:(BOOL)blacklist
{
    NSString *kw = ABNormalizeKeyword(keyword);
    if (kw.length == 0) {
        return;
    }

    @synchronized (self) {
        NSMutableArray *list = [(blacklist ? self.blacklist : self.whitelist) mutableCopy];
        if (!list) {
            list = [NSMutableArray array];
        }
        if ([list containsObject:kw]) {
            return;
        }
        [list addObject:kw];

        if (blacklist) {
            self.blacklist = list;
        } else {
            self.whitelist = list;
        }
    }

    [self save];
}

- (void)removeKeywordAtIndex:(NSInteger)index blacklist:(BOOL)blacklist
{
    @synchronized (self) {
        NSMutableArray *list = [(blacklist ? self.blacklist : self.whitelist) mutableCopy];
        if (index < 0 || index >= (NSInteger)list.count) {
            return;
        }
        [list removeObjectAtIndex:index];

        if (blacklist) {
            self.blacklist = list;
        } else {
            self.whitelist = list;
        }
    }

    [self save];
}

@end

// ============================================================
// 判断逻辑
// ============================================================

// 只根据黑白名单计算“是否应该拦截”，不处理观察者/关网开关。
static BOOL ABListDecision(NSString *host, NSString **reasonOut)
{
    ABConfig *cfg = [ABConfig shared];

    if (!cfg.enabled) {
        if (reasonOut) *reasonOut = @"disabled";
        return NO;
    }

    if (cfg.mode == ABModeWhitelist) {
        if (ABHostMatchesAny(host, cfg.whitelist)) {
            if (reasonOut) *reasonOut = @"whitelist";
            return NO;
        }
        if (reasonOut) *reasonOut = @"not-in-whitelist";
        return YES;
    }

    // 黑名单模式：白名单作为例外优先。
    if (cfg.whitelistException &&
        ABHostMatchesAny(host, cfg.whitelist)) {
        if (reasonOut) *reasonOut = @"whitelist-exception";
        return NO;
    }

    if (ABHostMatchesAny(host, cfg.blacklist)) {
        if (reasonOut) *reasonOut = @"blacklist";
        return YES;
    }

    if (reasonOut) *reasonOut = @"default-allow";
    return NO;
}

// 最终是否拦截：
//   - 关网开关优先；
//   - 观察者模式只记录，不拦截（关网开关除外）。
static BOOL ABShouldBlockHost(NSString *host, NSString **reasonOut)
{
    ABConfig *cfg = [ABConfig shared];

    if (cfg.blockAll) {
        if (reasonOut) *reasonOut = @"block-all";
        return YES;
    }

    NSString *listReason = nil;
    BOOL listBlock = ABListDecision(host, &listReason);

    if (cfg.observer) {
        if (reasonOut) {
            if (listBlock) {
                *reasonOut = [NSString stringWithFormat:@"%@ (observer, would block)",
                              listReason ?: @"rule"];
            } else {
                *reasonOut = [NSString stringWithFormat:@"%@ (observer)",
                              listReason ?: @"rule"];
            }
        }
        return NO;
    }

    if (reasonOut) *reasonOut = listReason;
    return listBlock;
}

// 给设置界面的“测试”使用：不写日志，只返回结果。
static NSString *ABDecisionSummaryForString(NSString *input)
{
    NSString *host = ABHostFromURLString(input);
    if (host.length == 0) {
        host = ABNormalizeKeyword(input);
    }
    if (host.length == 0) {
        return @"无法识别域名或 URL";
    }

    NSString *reason = nil;
    BOOL block = ABShouldBlockHost(host, &reason);

    return [NSString stringWithFormat:
            @"域名：%@\n结果：%@\n原因：%@",
            host,
            block ? @"拦截" : @"放行",
            reason ?: @"-"];
}

// ============================================================
// 日志（只记录域名）
// ============================================================

@interface ABLogStore : NSObject

+ (instancetype)shared;
- (void)addHost:(NSString *)host block:(BOOL)block reason:(NSString *)reason;
- (NSArray<NSDictionary *> *)snapshot;
- (void)clear;

@end

@implementation ABLogStore {
    NSMutableArray<NSDictionary *> *_entries;
    dispatch_queue_t _queue;
}

+ (instancetype)shared
{
    static ABLogStore *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[ABLogStore alloc] init];
    });
    return instance;
}

- (instancetype)init
{
    self = [super init];
    if (self) {
        _entries = [NSMutableArray array];
        _queue = dispatch_queue_create("com.ab.adblock.log", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)addHost:(NSString *)host block:(BOOL)block reason:(NSString *)reason
{
    if (host.length == 0) {
        return;
    }

    NSDateFormatter *fmt = [[NSDateFormatter alloc] init];
    [fmt setDateFormat:@"HH:mm:ss"];
    NSString *time = [fmt stringFromDate:[NSDate date]];

    NSDictionary *entry = @{
        @"time": time ?: @"",
        @"host": host,
        @"block": @(block),
        @"reason": reason ?: @""
    };

    dispatch_async(_queue, ^{
        [self->_entries addObject:entry];
        if (self->_entries.count > (NSUInteger)kABMaxLogEntries) {
            [self->_entries removeObjectsInRange:
             NSMakeRange(0, self->_entries.count - kABMaxLogEntries)];
        }
    });
}

- (NSArray<NSDictionary *> *)snapshot
{
    __block NSArray *result = nil;
    dispatch_sync(_queue, ^{
        result = [self->_entries copy];
    });
    return result ?: @[];
}

- (void)clear
{
    dispatch_async(_queue, ^{
        [self->_entries removeAllObjects];
    });
}

@end

// ============================================================
// URL 处理
// ============================================================

static NSString *ABProcessURLStringInner(NSString *s)
{
    if (![s isKindOfClass:[NSString class]] || s.length == 0) {
        return s;
    }

    if (ABSIsSentinelURLString(s)) {
        return s;
    }

    NSString *host = ABHostFromURLString(s);
    if (host.length == 0) {
        return s;
    }

    NSString *reason = nil;
    BOOL block = ABShouldBlockHost(host, &reason);

    ABConfig *cfg = [ABConfig shared];
    if (cfg.observer || cfg.blockAll || block) {
        [[ABLogStore shared] addHost:host block:block reason:reason ?: @""];
    }

    return block ? kABBlockedURL : s;
}

// 防止嵌套 hook 造成同一请求重复处理/重复记录。
static NSString *ABProcessURLString(NSString *s)
{
    static __thread BOOL processing = NO;

    if (processing) {
        return s;
    }

    processing = YES;
    NSString *result = ABProcessURLStringInner(s);
    processing = NO;

    return result;
}

static NSURL *ABProcessNSURL(NSURL *url)
{
    if (!url) {
        return nil;
    }

    NSString *s = url.absoluteString;
    if (s.length == 0) {
        return url;
    }

    NSString *processed = ABProcessURLString(s);
    if (processed == s || [processed isEqualToString:s]) {
        return url;
    }

    // 这里会再次进入 NSURL 的 hook，但 sentinel 会被直接放行。
    return [[NSURL alloc] initWithString:processed];
}

static NSURLRequest *ABProcessRequest(NSURLRequest *request)
{
    if (!request) {
        return nil;
    }

    NSURL *url = request.URL;
    NSURL *processed = ABProcessNSURL(url);
    if (!processed || processed == url || [processed isEqual:url]) {
        return request;
    }

    NSMutableURLRequest *mutable = [request mutableCopy];
    mutable.URL = processed;
    return mutable;
}

static BOOL ABRequestIsBlocked(NSURLRequest *request)
{
    if (!request || !request.URL) {
        return NO;
    }
    NSString *processed = ABProcessURLString(request.URL.absoluteString);
    return ABSIsSentinelURLString(processed);
}

// ============================================================
// 三指双击手势
// ============================================================

static const void *kABGestureKey = &kABGestureKey;

static BOOL gGestureStarted = NO;
static BOOL gGestureActive = NO;
static NSUInteger gGestureGeneration = 0;
static NSUInteger gGestureBootAttempts = 0;

static BOOL ABWindowIsVisible(UIWindow *window)
{
    return window &&
           !window.isHidden &&
           window.alpha > 0.01 &&
           window.windowLevel >= UIWindowLevelNormal;
}

static NSArray<UIWindow *> *ABAllWindows(void)
{
    NSMutableArray<UIWindow *> *result = [NSMutableArray array];

    if (@available(iOS 13.0, *)) {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) {
                continue;
            }
            UIWindowScene *windowScene = (UIWindowScene *)scene;
            [result addObjectsFromArray:windowScene.windows];
        }
    }

    [result addObjectsFromArray:[UIApplication sharedApplication].windows];

    // 去重
    NSMutableArray<UIWindow *> *unique = [NSMutableArray array];
    for (UIWindow *w in result) {
        if (![unique containsObject:w]) {
            [unique addObject:w];
        }
    }
    return unique;
}

static void ABRemoveAllGestures(void)
{
    for (UIWindow *window in ABAllWindows()) {
        UIGestureRecognizer *gesture =
            objc_getAssociatedObject(window, kABGestureKey);
        if (gesture) {
            [window removeGestureRecognizer:gesture];
            objc_setAssociatedObject(window, kABGestureKey, nil,
                                     OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
    }
}

static void ABStopGestureWindow(void)
{
    gGestureActive = NO;
    gGestureGeneration += 1;
    ABRemoveAllGestures();
}

static void ABShowStartupOverlay(void);
static void ABHideStartupOverlay(void);
static void ABUpdateStartupOverlayAlpha(void);

@interface ABGestureHandler : NSObject <UIGestureRecognizerDelegate>
+ (instancetype)shared;
- (void)handleGesture:(UITapGestureRecognizer *)gesture;
@end

@implementation ABGestureHandler

+ (instancetype)shared
{
    static ABGestureHandler *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[ABGestureHandler alloc] init];
    });
    return instance;
}

- (void)handleGesture:(UITapGestureRecognizer *)gesture
{
    if (gesture.state != UIGestureRecognizerStateEnded) {
        return;
    }

    if ([ABSettingsPresenter presentNow]) {
        ABHideStartupOverlay();
        ABStopGestureWindow();
    }
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer
{
    return YES;
}

@end

static void ABInstallGestureOnWindow(UIWindow *window)
{
    if (!window || !gGestureActive || !ABWindowIsVisible(window)) {
        return;
    }

    if (objc_getAssociatedObject(window, kABGestureKey)) {
        return;
    }

    window.multipleTouchEnabled = YES;
    window.rootViewController.view.multipleTouchEnabled = YES;

    UITapGestureRecognizer *gesture =
        [[UITapGestureRecognizer alloc] initWithTarget:[ABGestureHandler shared]
                                                action:@selector(handleGesture:)];
    gesture.numberOfTouchesRequired = 3;
    gesture.numberOfTapsRequired = 2;
    gesture.cancelsTouchesInView = NO;
    gesture.delaysTouchesBegan = NO;
    gesture.delaysTouchesEnded = NO;
    gesture.delegate = [ABGestureHandler shared];

    [window addGestureRecognizer:gesture];
    objc_setAssociatedObject(window, kABGestureKey, gesture,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

static void ABScanVisibleWindows(NSUInteger generation)
{
    if (!gGestureActive || generation != gGestureGeneration) {
        return;
    }

    for (UIWindow *window in ABAllWindows()) {
        if (ABWindowIsVisible(window)) {
            ABInstallGestureOnWindow(window);
        }
    }

    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            ABScanVisibleWindows(generation);
        }
    );
}

static void ABStartGestureWindowIfNeeded(void)
{
    if (gGestureStarted) {
        return;
    }

    if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) {
        return;
    }

    NSArray<UIWindow *> *windows = ABAllWindows();
    BOOL hasVisibleWindow = NO;
    for (UIWindow *window in windows) {
        if (ABWindowIsVisible(window)) {
            hasVisibleWindow = YES;
            break;
        }
    }
    if (!hasVisibleWindow) {
        return;
    }

    gGestureStarted = YES;
    gGestureActive = YES;

    for (UIWindow *window in windows) {
        if (ABWindowIsVisible(window)) {
            ABInstallGestureOnWindow(window);
        }
    }

    gGestureGeneration += 1;
    NSUInteger generation = gGestureGeneration;

    ABScanVisibleWindows(generation);
    ABShowStartupOverlay();

    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kABGestureWindow * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            if (generation != gGestureGeneration) {
                return;
            }
            ABStopGestureWindow();
        }
    );
}

static void ABBootScan(void)
{
    if (gGestureStarted) {
        return;
    }

    ABStartGestureWindowIfNeeded();
    if (gGestureStarted) {
        return;
    }

    gGestureBootAttempts += 1;
    if (gGestureBootAttempts >= 240) {
        return;
    }

    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            ABBootScan();
        }
    );
}

// ============================================================
// 启动悬浮窗
// ============================================================

typedef NS_ENUM(NSInteger, ABOverlayCorner) {
    ABOverlayCornerBottomRight = 0,
    ABOverlayCornerBottomLeft,
    ABOverlayCornerTopRight,
    ABOverlayCornerTopLeft
};

static UIWindow *gOverlayWindow = nil;
static UIButton *gOverlayButton = nil;
static NSUInteger gOverlayGeneration = 0;

static CGPoint ABClampStartupOverlayCenter(CGPoint center, CGSize size);
static CGPoint ABConfiguredStartupOverlayCenter(CGSize size);
static void ABScheduleStartupOverlayAutoHide(void);
static void ABSaveStartupOverlayPosition(CGPoint center, CGSize size);
static void ABUpdateStartupOverlayPosition(void);

@interface ABOverlayTarget : NSObject
- (void)tap:(id)sender;
- (void)pan:(UIPanGestureRecognizer *)gesture;
@end

@implementation ABOverlayTarget

- (void)tap:(id)sender
{
    if ([ABSettingsPresenter presentNow]) {
        ABHideStartupOverlay();
        ABStopGestureWindow();
    }
}

- (void)pan:(UIPanGestureRecognizer *)gesture
{
    UIWindow *window = gesture.view.window;
    if (!window) {
        return;
    }

    CGSize screenSize = [UIScreen mainScreen].bounds.size;
    UIWindow *reference = [UIApplication sharedApplication].keyWindow;
    if (!reference || reference == window) {
        reference = window;
    }
    CGPoint translation = [gesture translationInView:reference];
    CGPoint center = window.center;
    center.x += translation.x;
    center.y += translation.y;
    center = ABClampStartupOverlayCenter(center, screenSize);
    window.center = center;
    [gesture setTranslation:CGPointZero inView:reference];

    if (gesture.state == UIGestureRecognizerStateBegan) {
        ABScheduleStartupOverlayAutoHide();
    } else if (gesture.state == UIGestureRecognizerStateEnded ||
               gesture.state == UIGestureRecognizerStateCancelled) {
        ABSaveStartupOverlayPosition(center, screenSize);
        ABScheduleStartupOverlayAutoHide();
    }
}

@end

static ABOverlayTarget *gOverlayTarget = nil;

static CGFloat ABOverlayAlpha(void)
{
    CGFloat alpha = [ABConfig shared].overlayAlpha;
    if (alpha < 0.1) {
        alpha = 0.1;
    } else if (alpha > 1.0) {
        alpha = 1.0;
    }
    return alpha;
}

static CGPoint ABClampStartupOverlayCenter(CGPoint center, CGSize size)
{
    CGFloat halfWidth = kABOverlayButtonWidth / 2.0;
    CGFloat halfHeight = kABOverlayButtonHeight / 2.0;
    CGFloat minX = halfWidth + kABOverlayDragMargin;
    CGFloat maxX = size.width - halfWidth - kABOverlayDragMargin;
    CGFloat minY = halfHeight + kABOverlayDragMargin;
    CGFloat maxY = size.height - halfHeight - kABOverlayDragMargin;

    if (center.x < minX) {
        center.x = minX;
    } else if (center.x > maxX) {
        center.x = maxX;
    }
    if (center.y < minY) {
        center.y = minY;
    } else if (center.y > maxY) {
        center.y = maxY;
    }
    return center;
}

static CGPoint ABDefaultStartupOverlayCenter(CGSize size)
{
    return CGPointMake(size.width - kABOverlayEdgeMargin - kABOverlayButtonWidth / 2.0,
                       size.height - kABOverlayEdgeMargin - kABOverlayBottomExtra -
                           kABOverlayButtonHeight / 2.0);
}

static BOOL ABHasCustomOverlayPosition(void)
{
    ABConfig *cfg = [ABConfig shared];
    return cfg.overlayCenterX >= 0.0 && cfg.overlayCenterX <= 1.0 &&
           cfg.overlayCenterY >= 0.0 && cfg.overlayCenterY <= 1.0;
}

static CGPoint ABConfiguredStartupOverlayCenter(CGSize size)
{
    if (ABHasCustomOverlayPosition()) {
        ABConfig *cfg = [ABConfig shared];
        return CGPointMake(cfg.overlayCenterX * size.width,
                           cfg.overlayCenterY * size.height);
    }
    return ABDefaultStartupOverlayCenter(size);
}

static NSString *ABStartupOverlayPositionName(void)
{
    if (!ABHasCustomOverlayPosition()) {
        return @"右下";
    }

    ABConfig *cfg = [ABConfig shared];
    BOOL left = cfg.overlayCenterX < 0.5;
    BOOL top = cfg.overlayCenterY < 0.5;
    if (top) {
        return left ? @"左上" : @"右上";
    }
    return left ? @"左下" : @"右下";
}

static UIWindowScene *ABOverlayScene(void)
{
    if (@available(iOS 13.0, *)) {
        UIWindow *keyWindow = [UIApplication sharedApplication].keyWindow;
        if (keyWindow.windowScene) {
            return keyWindow.windowScene;
        }

        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) {
                continue;
            }
            if (scene.activationState == UISceneActivationStateForegroundActive) {
                return (UIWindowScene *)scene;
            }
        }

        for (UIWindow *window in [UIApplication sharedApplication].windows) {
            if (window.windowScene) {
                return window.windowScene;
            }
        }
    }
    return nil;
}

static void ABHideStartupOverlay(void)
{
    gOverlayGeneration += 1;

    UIWindow *window = gOverlayWindow;
    gOverlayWindow = nil;
    gOverlayButton = nil;

    if (window) {
        window.hidden = YES;
        window.rootViewController = nil;
    }
}

static void ABScheduleStartupOverlayAutoHide(void)
{
    NSUInteger generation = ++gOverlayGeneration;
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kABOverlayDuration * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            if (generation == gOverlayGeneration) {
                ABHideStartupOverlay();
            }
        }
    );
}

static void ABSaveStartupOverlayPosition(CGPoint center, CGSize size)
{
    if (size.width <= 0.0 || size.height <= 0.0) {
        return;
    }

    ABConfig *cfg = [ABConfig shared];
    cfg.overlayCenterX = center.x / size.width;
    cfg.overlayCenterY = center.y / size.height;
    [cfg save];
}

static void ABUpdateStartupOverlayAlpha(void)
{
    if (!gOverlayButton) {
        return;
    }
    gOverlayButton.backgroundColor = [UIColor colorWithWhite:0.0 alpha:ABOverlayAlpha()];
}

static void ABUpdateStartupOverlayPosition(void)
{
    if (!gOverlayWindow) {
        return;
    }

    CGSize size = [UIScreen mainScreen].bounds.size;
    if (size.width <= 0.0 || size.height <= 0.0) {
        return;
    }
    gOverlayWindow.center =
        ABClampStartupOverlayCenter(ABConfiguredStartupOverlayCenter(size), size);
}

static void ABSetStartupOverlayCorner(ABOverlayCorner corner)
{
    CGSize size = [UIScreen mainScreen].bounds.size;
    if (size.width <= 0.0 || size.height <= 0.0) {
        return;
    }

    BOOL left = (corner == ABOverlayCornerBottomLeft ||
                 corner == ABOverlayCornerTopLeft);
    BOOL top = (corner == ABOverlayCornerTopRight ||
                corner == ABOverlayCornerTopLeft);
    CGFloat centerX = left
        ? kABOverlayEdgeMargin + kABOverlayButtonWidth / 2.0
        : size.width - kABOverlayEdgeMargin - kABOverlayButtonWidth / 2.0;
    CGFloat centerY = top
        ? kABOverlayTopExtra + kABOverlayButtonHeight / 2.0
        : size.height - kABOverlayEdgeMargin - kABOverlayBottomExtra -
              kABOverlayButtonHeight / 2.0;

    ABConfig *cfg = [ABConfig shared];
    cfg.overlayCenterX = centerX / size.width;
    cfg.overlayCenterY = centerY / size.height;
    [cfg save];
    ABUpdateStartupOverlayPosition();
}

static void ABShowStartupOverlay(void)
{
    if (gOverlayWindow && !gOverlayWindow.isHidden) {
        ABUpdateStartupOverlayAlpha();
        ABUpdateStartupOverlayPosition();
        return;
    }

    UIWindowScene *scene = nil;
    if (@available(iOS 13.0, *)) {
        scene = ABOverlayScene();
        if (!scene) {
            return;
        }
    }

    CGSize screenSize = [UIScreen mainScreen].bounds.size;
    CGPoint center =
        ABClampStartupOverlayCenter(ABConfiguredStartupOverlayCenter(screenSize),
                                    screenSize);
    CGRect windowFrame = CGRectMake(center.x - kABOverlayButtonWidth / 2.0,
                                    center.y - kABOverlayButtonHeight / 2.0,
                                    kABOverlayButtonWidth,
                                    kABOverlayButtonHeight);
    UIWindow *window = [[UIWindow alloc] initWithFrame:windowFrame];
    if (@available(iOS 13.0, *)) {
        window.windowScene = scene;
    }
    window.windowLevel = UIWindowLevelAlert + 50;
    window.backgroundColor = [UIColor clearColor];

    UIViewController *controller = [[UIViewController alloc] init];
    controller.view.backgroundColor = [UIColor clearColor];

    UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
    button.frame = CGRectMake(0.0, 0.0, kABOverlayButtonWidth, kABOverlayButtonHeight);
    button.backgroundColor = [UIColor colorWithWhite:0.0 alpha:ABOverlayAlpha()];
    [button setTitle:@"设置" forState:UIControlStateNormal];
    [button setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];

    if (!gOverlayTarget) {
        gOverlayTarget = [[ABOverlayTarget alloc] init];
    }
    [button addTarget:gOverlayTarget
               action:@selector(tap:)
     forControlEvents:UIControlEventTouchUpInside];

    UIPanGestureRecognizer *pan =
        [[UIPanGestureRecognizer alloc] initWithTarget:gOverlayTarget
                                                action:@selector(pan:)];
    pan.minimumNumberOfTouches = 1;
    pan.maximumNumberOfTouches = 1;
    [button addGestureRecognizer:pan];

    [controller.view addSubview:button];
    window.rootViewController = controller;
    window.hidden = NO;

    gOverlayWindow = window;
    gOverlayButton = button;

    ABScheduleStartupOverlayAutoHide();
}

// ============================================================
// 最近请求界面
// ============================================================

@interface ABLogViewController : UITableViewController
@property (nonatomic, copy) NSArray<NSDictionary *> *logs;
@end

@interface ABLogViewController ()
- (void)reloadLogs;
- (void)clearLogs;
@end

@implementation ABLogViewController

- (void)viewDidLoad
{
    [super viewDidLoad];

    self.title = @"最近请求";
    self.navigationItem.rightBarButtonItem =
        [[UIBarButtonItem alloc] initWithTitle:@"清空"
                                         style:UIBarButtonItemStylePlain
                                        target:self
                                        action:@selector(clearLogs)];
    [self reloadLogs];
}

- (void)viewWillAppear:(BOOL)animated
{
    [super viewWillAppear:animated];
    [self reloadLogs];
}

- (void)reloadLogs
{
    self.logs = [[ABLogStore shared] snapshot];
    [self.tableView reloadData];
}

- (void)clearLogs
{
    [[ABLogStore shared] clear];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.15 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [self reloadLogs];
    });
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView
{
    return 1;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section
{
    return self.logs.count ?: 1;
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section
{
    return @"只记录域名，不记录路径和查询参数";
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath
{
    if (self.logs.count == 0) {
        UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault
                                                       reuseIdentifier:nil];
        cell.textLabel.text = @"暂无记录";
        cell.textLabel.textColor = [UIColor secondaryLabelColor];
        cell.selectionStyle = UITableViewCellSelectionStyleNone;
        return cell;
    }

    static NSString *identifier = @"ABLogCell";
    UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:identifier];
    if (!cell) {
        cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle
                                      reuseIdentifier:identifier];
    }

    NSDictionary *entry = self.logs[indexPath.row];
    cell.textLabel.text = entry[@"host"];
    cell.detailTextLabel.text = [NSString stringWithFormat:@"%@  %@  %@",
                                 entry[@"time"] ?: @"",
                                 [entry[@"block"] boolValue] ? @"拦截" : @"放行",
                                 entry[@"reason"] ?: @""];
    cell.detailTextLabel.textColor = [entry[@"block"] boolValue]
        ? [UIColor systemRedColor]
        : [UIColor secondaryLabelColor];
    cell.selectionStyle = UITableViewCellSelectionStyleNone;
    return cell;
}

@end

// ============================================================
// 设置界面
// ============================================================

typedef NS_ENUM(NSInteger, ABSettingsSection) {
    ABSettingsSectionSwitches = 0,
    ABSettingsSectionMode,
    ABSettingsSectionBlacklist,
    ABSettingsSectionWhitelist,
    ABSettingsSectionLogs,
    ABSettingsSectionTools,
    ABSettingsSectionCount
};

@interface ABSettingsViewController : UITableViewController
@end

@interface ABSettingsViewController ()
- (UITableViewCell *)switchCellWithTitle:(NSString *)title
                                      on:(BOOL)on
                                 section:(NSInteger)section
                                     row:(NSInteger)row;
- (void)switchChanged:(UISwitch *)sw;
- (void)modeChanged:(UISegmentedControl *)segmented;
- (void)showAddKeywordBlacklist:(BOOL)blacklist;
- (void)showTestDialog;
- (void)showPositionDialog;
- (void)confirmReset;
- (void)overlayAlphaChanged:(UISlider *)slider;
- (void)done;
@end

@implementation ABSettingsViewController

- (void)viewDidLoad
{
    [super viewDidLoad];

    self.title = @"广告拦截设置";

    self.navigationItem.rightBarButtonItem =
        [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone
                                                      target:self
                                                      action:@selector(done)];
    self.tableView.rowHeight = UITableViewAutomaticDimension;
    self.tableView.estimatedRowHeight = 48.0;
}

- (void)done
{
    [ABSettingsPresenter dismiss];
}

- (void)viewWillAppear:(BOOL)animated
{
    [super viewWillAppear:animated];
    [self.tableView reloadData];
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView
{
    return ABSettingsSectionCount;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section
{
    ABConfig *cfg = [ABConfig shared];

    switch (section) {
        case ABSettingsSectionSwitches:
            return 4;
        case ABSettingsSectionMode:
            return 1;
        case ABSettingsSectionBlacklist:
            return cfg.blacklist.count + 1;
        case ABSettingsSectionWhitelist:
            return cfg.whitelist.count + 1;
        case ABSettingsSectionLogs:
            return 2;
        case ABSettingsSectionTools:
            return 4;
        default:
            return 0;
    }
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section
{
    switch (section) {
        case ABSettingsSectionSwitches:
            return @"开关";
        case ABSettingsSectionMode:
            return @"模式";
        case ABSettingsSectionBlacklist:
            return @"黑名单";
        case ABSettingsSectionWhitelist:
            return @"白名单";
        case ABSettingsSectionLogs:
            return @"观察记录";
        case ABSettingsSectionTools:
            return @"工具";
        default:
            return nil;
    }
}

- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section
{
    switch (section) {
        case ABSettingsSectionSwitches:
            return @"“关网开关”会阻断当前 App 所有 http/https 请求，用来判断广告是不是远端拉取。开启后 App 可能无法正常联网。";
        case ABSettingsSectionMode:
            return @"黑名单：默认放行，命中拦截。白名单：默认拦截，命中放行，可能导致 App 无法正常联网。";
        case ABSettingsSectionBlacklist:
            return @"带点的关键词按域名后缀匹配，例如 toutiao.com 会匹配 ads.toutiao.com；不带点的按包含匹配。";
        case ABSettingsSectionWhitelist:
            return @"白名单优先于黑名单，适合把 App 自己的关键接口加进来做例外。";
        case ABSettingsSectionLogs:
            return @"观察者模式开启后，这里会记录 App 请求过的域名，方便找广告域名。";
        case ABSettingsSectionTools:
            return @"启动时会在右下角显示 5 秒“设置”悬浮窗，按住可拖动位置；点击可直接打开本页。三指双击仍然有效。透明度与位置在下次启动生效。";
        default:
            return nil;
    }
}

- (UITableViewCell *)switchCellWithTitle:(NSString *)title
                                      on:(BOOL)on
                                 section:(NSInteger)section
                                     row:(NSInteger)row
{
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault
                                                   reuseIdentifier:nil];
    cell.textLabel.text = title;
    cell.selectionStyle = UITableViewCellSelectionStyleNone;

    UISwitch *sw = [[UISwitch alloc] init];
    sw.on = on;
    sw.tag = section * 100 + row;
    [sw addTarget:self
           action:@selector(switchChanged:)
 forControlEvents:UIControlEventValueChanged];
    cell.accessoryView = sw;

    return cell;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath
{
    ABConfig *cfg = [ABConfig shared];
    NSInteger section = indexPath.section;
    NSInteger row = indexPath.row;

    if (section == ABSettingsSectionSwitches) {
        switch (row) {
            case 0:
                return [self switchCellWithTitle:@"启用拦截" on:cfg.enabled
                                         section:section row:row];
            case 1:
                return [self switchCellWithTitle:@"关网开关（全部拦截）" on:cfg.blockAll
                                         section:section row:row];
            case 2:
                return [self switchCellWithTitle:@"观察者模式（只记录不拦截）" on:cfg.observer
                                         section:section row:row];
            case 3:
            default:
                return [self switchCellWithTitle:@"白名单例外（黑名单模式下）" on:cfg.whitelistException
                                         section:section row:row];
        }
    }

    if (section == ABSettingsSectionMode) {
        UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault
                                                       reuseIdentifier:nil];
        cell.textLabel.text = @"当前模式";
        cell.selectionStyle = UITableViewCellSelectionStyleNone;

        UISegmentedControl *segmented =
            [[UISegmentedControl alloc] initWithItems:@[@"黑名单", @"白名单"]];
        segmented.selectedSegmentIndex = (cfg.mode == ABModeWhitelist) ? 1 : 0;
        [segmented addTarget:self
                      action:@selector(modeChanged:)
            forControlEvents:UIControlEventValueChanged];
        cell.accessoryView = segmented;

        return cell;
    }

    if (section == ABSettingsSectionBlacklist || section == ABSettingsSectionWhitelist) {
        BOOL isBlacklist = (section == ABSettingsSectionBlacklist);
        NSArray<NSString *> *list = isBlacklist ? cfg.blacklist : cfg.whitelist;

        UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault
                                                       reuseIdentifier:nil];

        if (row == 0) {
            cell.textLabel.text = isBlacklist ? @"添加黑名单关键词" : @"添加白名单关键词";
            cell.textLabel.textColor = [UIColor systemBlueColor];
            cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
            return cell;
        }

        cell.textLabel.text = list[row - 1];
        cell.selectionStyle = UITableViewCellSelectionStyleNone;
        return cell;
    }

    if (section == ABSettingsSectionLogs) {
        UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault
                                                       reuseIdentifier:nil];
        if (row == 0) {
            cell.textLabel.text = [NSString stringWithFormat:@"查看最近请求（%lu）",
                                   (unsigned long)[[ABLogStore shared] snapshot].count];
            cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
        } else {
            cell.textLabel.text = @"清空记录";
            cell.textLabel.textColor = [UIColor systemRedColor];
        }
        return cell;
    }

    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault
                                                   reuseIdentifier:nil];
    if (section == ABSettingsSectionTools) {
        if (row == 0) {
            cell.textLabel.text = @"测试域名 / URL";
            cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
        } else if (row == 1) {
            cell.textLabel.text = @"启动悬浮窗透明度";
            cell.selectionStyle = UITableViewCellSelectionStyleNone;

            UISlider *slider = [[UISlider alloc] init];
            slider.frame = CGRectMake(0, 0, 160, 32);
            slider.minimumValue = 0.1;
            slider.maximumValue = 1.0;
            slider.value = cfg.overlayAlpha;
            [slider addTarget:self
                       action:@selector(overlayAlphaChanged:)
             forControlEvents:UIControlEventValueChanged];
            cell.accessoryView = slider;
        } else if (row == 2) {
            cell.textLabel.text =
                [NSString stringWithFormat:@"悬浮窗位置：%@",
                 ABStartupOverlayPositionName()];
            cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
        } else {
            cell.textLabel.text = @"恢复默认配置";
            cell.textLabel.textColor = [UIColor systemRedColor];
        }
        return cell;
    }

    return cell;
}

- (BOOL)tableView:(UITableView *)tableView canEditRowAtIndexPath:(NSIndexPath *)indexPath
{
    if (indexPath.section != ABSettingsSectionBlacklist &&
        indexPath.section != ABSettingsSectionWhitelist) {
        return NO;
    }
    return indexPath.row > 0;
}

- (void)tableView:(UITableView *)tableView
commitEditingStyle:(UITableViewCellEditingStyle)editingStyle
forRowAtIndexPath:(NSIndexPath *)indexPath
{
    if (editingStyle != UITableViewCellEditingStyleDelete) {
        return;
    }

    BOOL isBlacklist = (indexPath.section == ABSettingsSectionBlacklist);
    if (indexPath.section != ABSettingsSectionBlacklist &&
        indexPath.section != ABSettingsSectionWhitelist) {
        return;
    }
    if (indexPath.row == 0) {
        return;
    }

    [[ABConfig shared] removeKeywordAtIndex:indexPath.row - 1 blacklist:isBlacklist];
    [self.tableView reloadData];
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath
{
    [tableView deselectRowAtIndexPath:indexPath animated:YES];

    NSInteger section = indexPath.section;
    NSInteger row = indexPath.row;

    if (section == ABSettingsSectionBlacklist && row == 0) {
        [self showAddKeywordBlacklist:YES];
        return;
    }
    if (section == ABSettingsSectionWhitelist && row == 0) {
        [self showAddKeywordBlacklist:NO];
        return;
    }

    if (section == ABSettingsSectionLogs) {
        if (row == 0) {
            ABLogViewController *vc = [[ABLogViewController alloc] initWithStyle:UITableViewStyleGrouped];
            [self.navigationController pushViewController:vc animated:YES];
        } else {
            [[ABLogStore shared] clear];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.15 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{
                [self.tableView reloadData];
            });
        }
        return;
    }

    if (section == ABSettingsSectionTools) {
        if (row == 0) {
            [self showTestDialog];
        } else if (row == 2) {
            [self showPositionDialog];
        } else if (row == 3) {
            [self confirmReset];
        }
    }
}

- (void)overlayAlphaChanged:(UISlider *)slider
{
    ABConfig *cfg = [ABConfig shared];
    cfg.overlayAlpha = slider.value;
    [cfg save];
    ABUpdateStartupOverlayAlpha();
}

- (void)showPositionDialog
{
    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"悬浮窗位置"
                                            message:@"也可以直接在启动悬浮窗上拖动；选择四角会覆盖拖动位置。"
                                     preferredStyle:UIAlertControllerStyleAlert];

    void (^addCorner)(NSString *, ABOverlayCorner) =
        ^(NSString *title, ABOverlayCorner corner) {
            [alert addAction:[UIAlertAction actionWithTitle:title
                                                      style:UIAlertActionStyleDefault
                                                    handler:^(UIAlertAction *action) {
                ABSetStartupOverlayCorner(corner);
                [self.tableView reloadData];
            }]];
        };

    addCorner(@"右下角（默认）", ABOverlayCornerBottomRight);
    addCorner(@"左下角", ABOverlayCornerBottomLeft);
    addCorner(@"右上角", ABOverlayCornerTopRight);
    addCorner(@"左上角", ABOverlayCornerTopLeft);

    [alert addAction:[UIAlertAction actionWithTitle:@"取消"
                                              style:UIAlertActionStyleCancel
                                            handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)switchChanged:(UISwitch *)sw
{
    NSInteger section = sw.tag / 100;
    NSInteger row = sw.tag % 100;
    if (section != ABSettingsSectionSwitches) {
        return;
    }

    ABConfig *cfg = [ABConfig shared];

    if (row == 0) {
        cfg.enabled = sw.on;
        [cfg save];
        return;
    }

    if (row == 1) {
        if (!sw.on) {
            cfg.blockAll = NO;
            [cfg save];
            [self.tableView reloadData];
            return;
        }

        UIAlertController *alert =
            [UIAlertController alertControllerWithTitle:@"开启关网模式？"
                                                message:@"当前 App 的所有 http/https 请求都会被阻断，页面可能加载失败。这个开关用于判断广告是否来自远端。"
                                         preferredStyle:UIAlertControllerStyleAlert];
        [alert addAction:[UIAlertAction actionWithTitle:@"取消"
                                                  style:UIAlertActionStyleCancel
                                                handler:^(UIAlertAction *action) {
            sw.on = NO;
        }]];
        [alert addAction:[UIAlertAction actionWithTitle:@"开启"
                                                  style:UIAlertActionStyleDestructive
                                                handler:^(UIAlertAction *action) {
            cfg.blockAll = YES;
            [cfg save];
            [self.tableView reloadData];
        }]];
        [self presentViewController:alert animated:YES completion:nil];
        return;
    }

    if (row == 2) {
        cfg.observer = sw.on;
        [cfg save];
        return;
    }

    if (row == 3) {
        cfg.whitelistException = sw.on;
        [cfg save];
        return;
    }
}

- (void)modeChanged:(UISegmentedControl *)segmented
{
    ABConfig *cfg = [ABConfig shared];
    cfg.mode = (segmented.selectedSegmentIndex == 1) ? ABModeWhitelist : ABModeBlacklist;
    [cfg save];
    [self.tableView reloadData];
}

- (void)showAddKeywordBlacklist:(BOOL)blacklist
{
    NSString *title = blacklist ? @"添加黑名单关键词" : @"添加白名单关键词";

    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:title
                                            message:@"可以填域名、域名关键词，或完整 URL。带点的域名会匹配子域名。"
                                     preferredStyle:UIAlertControllerStyleAlert];

    [alert addTextFieldWithConfigurationHandler:^(UITextField *textField) {
        textField.placeholder = blacklist ? @"例如 toutiao.com" : @"例如 api.example.com";
        textField.autocapitalizationType = UITextAutocapitalizationTypeNone;
        textField.autocorrectionType = UITextAutocorrectionTypeNo;
    }];

    [alert addAction:[UIAlertAction actionWithTitle:@"取消"
                                              style:UIAlertActionStyleCancel
                                            handler:nil]];
    [alert addAction:[UIAlertAction actionWithTitle:@"添加"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        UITextField *field = alert.textFields.firstObject;
        [[ABConfig shared] addKeyword:field.text blacklist:blacklist];
        [self.tableView reloadData];
    }]];

    [self presentViewController:alert animated:YES completion:nil];
}

- (void)showTestDialog
{
    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"测试域名 / URL"
                                            message:@"输入域名或完整 URL，看看当前配置会放行还是拦截。"
                                     preferredStyle:UIAlertControllerStyleAlert];

    [alert addTextFieldWithConfigurationHandler:^(UITextField *textField) {
        textField.placeholder = @"例如 https://ads.example.com/x";
        textField.autocapitalizationType = UITextAutocapitalizationTypeNone;
        textField.autocorrectionType = UITextAutocorrectionTypeNo;
    }];

    [alert addAction:[UIAlertAction actionWithTitle:@"取消"
                                              style:UIAlertActionStyleCancel
                                            handler:nil]];
    [alert addAction:[UIAlertAction actionWithTitle:@"测试"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        UITextField *field = alert.textFields.firstObject;
        NSString *result = ABDecisionSummaryForString(field.text);
        UIAlertController *resultAlert =
            [UIAlertController alertControllerWithTitle:@"测试结果"
                                                message:result
                                         preferredStyle:UIAlertControllerStyleAlert];
        [resultAlert addAction:[UIAlertAction actionWithTitle:@"知道了"
                                                        style:UIAlertActionStyleDefault
                                                      handler:nil]];
        [self presentViewController:resultAlert animated:YES completion:nil];
    }]];

    [self presentViewController:alert animated:YES completion:nil];
}

- (void)confirmReset
{
    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"恢复默认配置？"
                                            message:@"会清空自定义黑白名单，并恢复默认设置。"
                                     preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"取消"
                                              style:UIAlertActionStyleCancel
                                            handler:nil]];
    [alert addAction:[UIAlertAction actionWithTitle:@"恢复"
                                              style:UIAlertActionStyleDestructive
                                            handler:^(UIAlertAction *action) {
        [[ABConfig shared] resetDefaults];
        ABUpdateStartupOverlayAlpha();
        ABUpdateStartupOverlayPosition();
        [self.tableView reloadData];
    }]];
    [self presentViewController:alert animated:YES completion:nil];
}

@end

// ============================================================
// 设置界面弹出
// ============================================================

@interface ABSettingsPresenter ()
+ (UIWindow *)activeWindow;
+ (UIWindowScene *)activeWindowScene;
@end

static UIWindow *gSettingsWindow = nil;
static __weak UIWindow *gPreviousKeyWindow = nil;

@implementation ABSettingsPresenter

+ (BOOL)presentNow
{
    if (gSettingsWindow && !gSettingsWindow.isHidden) {
        [gSettingsWindow makeKeyAndVisible];
        return YES;
    }

    UIWindow *host = [self activeWindow];
    UIWindowScene *scene = nil;
    if (@available(iOS 13.0, *)) {
        scene = host.windowScene;
        if (!scene) {
            scene = [self activeWindowScene];
        }
        if (!scene) {
            return NO;
        }
    }

    UIWindow *window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    if (@available(iOS 13.0, *)) {
        window.windowScene = scene;
    }
    window.windowLevel = UIWindowLevelAlert + 100;
    window.backgroundColor = [UIColor whiteColor];

    ABSettingsViewController *settings =
        [[ABSettingsViewController alloc] initWithStyle:UITableViewStyleGrouped];
    UINavigationController *nav =
        [[UINavigationController alloc] initWithRootViewController:settings];
    window.rootViewController = nav;

    gPreviousKeyWindow = [UIApplication sharedApplication].keyWindow;
    window.hidden = NO;
    [window makeKeyAndVisible];
    gSettingsWindow = window;
    return YES;
}

+ (void)dismiss
{
    UIWindow *window = gSettingsWindow;
    gSettingsWindow = nil;
    if (window) {
        window.hidden = YES;
        window.rootViewController = nil;
    }

    UIWindow *previous = gPreviousKeyWindow;
    gPreviousKeyWindow = nil;
    if (!previous) {
        previous = [self activeWindow];
    }
    if (previous && !previous.isHidden) {
        [previous makeKeyAndVisible];
    }
}

+ (UIWindow *)activeWindow
{
    UIWindow *fallback = nil;
    if (@available(iOS 13.0, *)) {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) {
                continue;
            }
            UIWindowScene *windowScene = (UIWindowScene *)scene;
            if (windowScene.activationState != UISceneActivationStateForegroundActive) {
                continue;
            }
            for (UIWindow *window in windowScene.windows) {
                if (!ABWindowIsVisible(window)) {
                    continue;
                }
                if (window.isKeyWindow) {
                    return window;
                }
                if (!fallback) {
                    fallback = window;
                }
            }
        }
    }

    if (fallback) {
        return fallback;
    }

    UIWindow *keyWindow = [UIApplication sharedApplication].keyWindow;
    if (ABWindowIsVisible(keyWindow)) {
        return keyWindow;
    }

    for (UIWindow *window in [UIApplication sharedApplication].windows) {
        if (ABWindowIsVisible(window)) {
            return window;
        }
    }
    return nil;
}

+ (UIWindowScene *)activeWindowScene
{
    if (@available(iOS 13.0, *)) {
        for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) {
                continue;
            }
            if (scene.activationState == UISceneActivationStateForegroundActive) {
                return (UIWindowScene *)scene;
            }
        }
        for (UIWindow *window in [UIApplication sharedApplication].windows) {
            if (window.windowScene) {
                return window.windowScene;
            }
        }
    }
    return nil;
}

@end

// ============================================================
// Runtime hooks（不依赖 Logos / CydiaSubstrate）
// ============================================================

static BOOL ABHookClassMethod(Class cls, SEL selector, IMP replacement, IMP *original)
{
    if (!cls) {
        return NO;
    }
    Method method = class_getClassMethod(cls, selector);
    if (!method) {
        return NO;
    }
    if (original) {
        *original = method_getImplementation(method);
    }
    method_setImplementation(method, replacement);
    return YES;
}

static BOOL ABHookInstanceMethod(Class cls, SEL selector, IMP replacement, IMP *original)
{
    if (!cls) {
        return NO;
    }
    Method method = class_getInstanceMethod(cls, selector);
    if (!method) {
        return NO;
    }
    if (original) {
        *original = method_getImplementation(method);
    }
    method_setImplementation(method, replacement);
    return YES;
}

// ---------- NSURL ----------

static NSURL *(*ab_orig_URLWithString)(id, SEL, NSString *);
static NSURL *ab_hook_URLWithString(id self, SEL _cmd, NSString *string)
{
    return ab_orig_URLWithString(self, _cmd, ABProcessURLString(string));
}

static NSURL *(*ab_orig_URLWithString_relative)(id, SEL, NSString *, NSURL *);
static NSURL *ab_hook_URLWithString_relative(id self, SEL _cmd, NSString *string, NSURL *baseURL)
{
    return ab_orig_URLWithString_relative(self, _cmd, ABProcessURLString(string), baseURL);
}

static id (*ab_orig_NSURL_initWithString)(id, SEL, NSString *);
static id ab_hook_NSURL_initWithString(id self, SEL _cmd, NSString *string)
{
    return ab_orig_NSURL_initWithString(self, _cmd, ABProcessURLString(string));
}

static id (*ab_orig_NSURL_initWithString_relative)(id, SEL, NSString *, NSURL *);
static id ab_hook_NSURL_initWithString_relative(id self, SEL _cmd, NSString *string, NSURL *baseURL)
{
    return ab_orig_NSURL_initWithString_relative(self, _cmd, ABProcessURLString(string), baseURL);
}

// ---------- NSURLComponents ----------

static NSURL *(*ab_orig_NSURLComponents_URL)(id, SEL);
static NSURL *ab_hook_NSURLComponents_URL(id self, SEL _cmd)
{
    return ABProcessNSURL(ab_orig_NSURLComponents_URL(self, _cmd));
}

// ---------- NSURLRequest ----------

static id (*ab_orig_NSURLRequest_requestWithURL)(id, SEL, NSURL *);
static id ab_hook_NSURLRequest_requestWithURL(id self, SEL _cmd, NSURL *url)
{
    return ab_orig_NSURLRequest_requestWithURL(self, _cmd, ABProcessNSURL(url));
}

static id (*ab_orig_NSURLRequest_initWithURL)(id, SEL, NSURL *);
static id ab_hook_NSURLRequest_initWithURL(id self, SEL _cmd, NSURL *url)
{
    return ab_orig_NSURLRequest_initWithURL(self, _cmd, ABProcessNSURL(url));
}

static id (*ab_orig_NSURLRequest_initWithURL_cache)(id, SEL, NSURL *, NSURLRequestCachePolicy, NSTimeInterval);
static id ab_hook_NSURLRequest_initWithURL_cache(id self, SEL _cmd, NSURL *url,
                                                 NSURLRequestCachePolicy policy,
                                                 NSTimeInterval timeout)
{
    return ab_orig_NSURLRequest_initWithURL_cache(self, _cmd, ABProcessNSURL(url), policy, timeout);
}

// ---------- NSURLSession ----------

static NSURLSessionDataTask *(*ab_orig_session_dataTaskWithURL)(id, SEL, NSURL *);
static NSURLSessionDataTask *ab_hook_session_dataTaskWithURL(id self, SEL _cmd, NSURL *url)
{
    return ab_orig_session_dataTaskWithURL(self, _cmd, ABProcessNSURL(url));
}

static NSURLSessionDataTask *(*ab_orig_session_dataTaskWithURL_completion)(id, SEL, NSURL *, void (^)(NSData *, NSURLResponse *, NSError *));
static NSURLSessionDataTask *ab_hook_session_dataTaskWithURL_completion(id self, SEL _cmd,
                                                                       NSURL *url,
                                                                       void (^handler)(NSData *, NSURLResponse *, NSError *))
{
    return ab_orig_session_dataTaskWithURL_completion(self, _cmd, ABProcessNSURL(url), handler);
}

static NSURLSessionDataTask *(*ab_orig_session_dataTaskWithRequest)(id, SEL, NSURLRequest *);
static NSURLSessionDataTask *ab_hook_session_dataTaskWithRequest(id self, SEL _cmd, NSURLRequest *request)
{
    return ab_orig_session_dataTaskWithRequest(self, _cmd, ABProcessRequest(request));
}

static NSURLSessionDataTask *(*ab_orig_session_dataTaskWithRequest_completion)(id, SEL, NSURLRequest *, void (^)(NSData *, NSURLResponse *, NSError *));
static NSURLSessionDataTask *ab_hook_session_dataTaskWithRequest_completion(id self, SEL _cmd,
                                                                           NSURLRequest *request,
                                                                           void (^handler)(NSData *, NSURLResponse *, NSError *))
{
    return ab_orig_session_dataTaskWithRequest_completion(self, _cmd, ABProcessRequest(request), handler);
}

static NSURLSessionDownloadTask *(*ab_orig_session_downloadTaskWithURL)(id, SEL, NSURL *);
static NSURLSessionDownloadTask *ab_hook_session_downloadTaskWithURL(id self, SEL _cmd, NSURL *url)
{
    return ab_orig_session_downloadTaskWithURL(self, _cmd, ABProcessNSURL(url));
}

static NSURLSessionDownloadTask *(*ab_orig_session_downloadTaskWithRequest)(id, SEL, NSURLRequest *);
static NSURLSessionDownloadTask *ab_hook_session_downloadTaskWithRequest(id self, SEL _cmd, NSURLRequest *request)
{
    return ab_orig_session_downloadTaskWithRequest(self, _cmd, ABProcessRequest(request));
}

static NSURLSessionUploadTask *(*ab_orig_session_uploadTaskWithRequest)(id, SEL, NSURLRequest *, NSData *);
static NSURLSessionUploadTask *ab_hook_session_uploadTaskWithRequest(id self, SEL _cmd,
                                                                     NSURLRequest *request,
                                                                     NSData *bodyData)
{
    return ab_orig_session_uploadTaskWithRequest(self, _cmd, ABProcessRequest(request), bodyData);
}

// ---------- NSURLConnection ----------

static NSURLConnection *(*ab_orig_connectionWithRequest)(id, SEL, NSURLRequest *, id);
static NSURLConnection *ab_hook_connectionWithRequest(id self, SEL _cmd,
                                                      NSURLRequest *request,
                                                      id delegate)
{
    return ab_orig_connectionWithRequest(self, _cmd, ABProcessRequest(request), delegate);
}

static id (*ab_orig_NSURLConnection_initWithRequest)(id, SEL, NSURLRequest *, id);
static id ab_hook_NSURLConnection_initWithRequest(id self, SEL _cmd,
                                                  NSURLRequest *request,
                                                  id delegate)
{
    return ab_orig_NSURLConnection_initWithRequest(self, _cmd, ABProcessRequest(request), delegate);
}

static id (*ab_orig_NSURLConnection_initWithRequest_start)(id, SEL, NSURLRequest *, id, BOOL);
static id ab_hook_NSURLConnection_initWithRequest_start(id self, SEL _cmd,
                                                        NSURLRequest *request,
                                                        id delegate,
                                                        BOOL startImmediately)
{
    return ab_orig_NSURLConnection_initWithRequest_start(self, _cmd,
                                                         ABProcessRequest(request),
                                                         delegate,
                                                         startImmediately);
}

// ---------- WebView ----------

static WKNavigation *(*ab_orig_WKWebView_loadRequest)(id, SEL, NSURLRequest *);
static WKNavigation *ab_hook_WKWebView_loadRequest(id self, SEL _cmd, NSURLRequest *request)
{
    if (ABRequestIsBlocked(request)) {
        NSURL *blank = [[NSURL alloc] initWithString:@"about:blank"];
        NSURLRequest *blankRequest = [NSURLRequest requestWithURL:blank];
        return ab_orig_WKWebView_loadRequest(self, _cmd, blankRequest);
    }
    return ab_orig_WKWebView_loadRequest(self, _cmd, request);
}

static void (*ab_orig_UIWebView_loadRequest)(id, SEL, NSURLRequest *);
static void ab_hook_UIWebView_loadRequest(id self, SEL _cmd, NSURLRequest *request)
{
    if (ABRequestIsBlocked(request)) {
        NSURL *blank = [[NSURL alloc] initWithString:@"about:blank"];
        NSURLRequest *blankRequest = [NSURLRequest requestWithURL:blank];
        ab_orig_UIWebView_loadRequest(self, _cmd, blankRequest);
        return;
    }
    ab_orig_UIWebView_loadRequest(self, _cmd, request);
}

// ---------- UIWindow ----------

static void (*ab_orig_UIWindow_makeKeyAndVisible)(id, SEL);
static void ab_hook_UIWindow_makeKeyAndVisible(id self, SEL _cmd)
{
    ab_orig_UIWindow_makeKeyAndVisible(self, _cmd);

    if (gGestureActive) {
        ABInstallGestureOnWindow((UIWindow *)self);
    } else {
        ABStartGestureWindowIfNeeded();
    }
}

static void (*ab_orig_UIWindow_becomeKeyWindow)(id, SEL);
static void ab_hook_UIWindow_becomeKeyWindow(id self, SEL _cmd)
{
    ab_orig_UIWindow_becomeKeyWindow(self, _cmd);

    if (gGestureActive) {
        ABInstallGestureOnWindow((UIWindow *)self);
    } else {
        ABStartGestureWindowIfNeeded();
    }
}

// ---------- 安装 ----------

static void ABInstallHooks(void)
{
    Class cls = Nil;

    cls = NSClassFromString(@"NSURL");
    ABHookClassMethod(cls, @selector(URLWithString:),
                      (IMP)ab_hook_URLWithString,
                      (IMP *)&ab_orig_URLWithString);
    ABHookClassMethod(cls, @selector(URLWithString:relativeToURL:),
                      (IMP)ab_hook_URLWithString_relative,
                      (IMP *)&ab_orig_URLWithString_relative);
    ABHookInstanceMethod(cls, @selector(initWithString:),
                         (IMP)ab_hook_NSURL_initWithString,
                         (IMP *)&ab_orig_NSURL_initWithString);
    ABHookInstanceMethod(cls, @selector(initWithString:relativeToURL:),
                         (IMP)ab_hook_NSURL_initWithString_relative,
                         (IMP *)&ab_orig_NSURL_initWithString_relative);

    cls = NSClassFromString(@"NSURLComponents");
    ABHookInstanceMethod(cls, @selector(URL),
                         (IMP)ab_hook_NSURLComponents_URL,
                         (IMP *)&ab_orig_NSURLComponents_URL);

    cls = NSClassFromString(@"NSURLRequest");
    ABHookClassMethod(cls, @selector(requestWithURL:),
                      (IMP)ab_hook_NSURLRequest_requestWithURL,
                      (IMP *)&ab_orig_NSURLRequest_requestWithURL);
    ABHookInstanceMethod(cls, @selector(initWithURL:),
                         (IMP)ab_hook_NSURLRequest_initWithURL,
                         (IMP *)&ab_orig_NSURLRequest_initWithURL);
    ABHookInstanceMethod(cls, @selector(initWithURL:cachePolicy:timeoutInterval:),
                         (IMP)ab_hook_NSURLRequest_initWithURL_cache,
                         (IMP *)&ab_orig_NSURLRequest_initWithURL_cache);

    cls = NSClassFromString(@"NSURLSession");
    ABHookInstanceMethod(cls, @selector(dataTaskWithURL:),
                         (IMP)ab_hook_session_dataTaskWithURL,
                         (IMP *)&ab_orig_session_dataTaskWithURL);
    ABHookInstanceMethod(cls, @selector(dataTaskWithURL:completionHandler:),
                         (IMP)ab_hook_session_dataTaskWithURL_completion,
                         (IMP *)&ab_orig_session_dataTaskWithURL_completion);
    ABHookInstanceMethod(cls, @selector(dataTaskWithRequest:),
                         (IMP)ab_hook_session_dataTaskWithRequest,
                         (IMP *)&ab_orig_session_dataTaskWithRequest);
    ABHookInstanceMethod(cls, @selector(dataTaskWithRequest:completionHandler:),
                         (IMP)ab_hook_session_dataTaskWithRequest_completion,
                         (IMP *)&ab_orig_session_dataTaskWithRequest_completion);
    ABHookInstanceMethod(cls, @selector(downloadTaskWithURL:),
                         (IMP)ab_hook_session_downloadTaskWithURL,
                         (IMP *)&ab_orig_session_downloadTaskWithURL);
    ABHookInstanceMethod(cls, @selector(downloadTaskWithRequest:),
                         (IMP)ab_hook_session_downloadTaskWithRequest,
                         (IMP *)&ab_orig_session_downloadTaskWithRequest);
    ABHookInstanceMethod(cls, @selector(uploadTaskWithRequest:fromData:),
                         (IMP)ab_hook_session_uploadTaskWithRequest,
                         (IMP *)&ab_orig_session_uploadTaskWithRequest);

    cls = NSClassFromString(@"NSURLConnection");
    ABHookClassMethod(cls, @selector(connectionWithRequest:delegate:),
                      (IMP)ab_hook_connectionWithRequest,
                      (IMP *)&ab_orig_connectionWithRequest);
    ABHookInstanceMethod(cls, @selector(initWithRequest:delegate:),
                         (IMP)ab_hook_NSURLConnection_initWithRequest,
                         (IMP *)&ab_orig_NSURLConnection_initWithRequest);
    ABHookInstanceMethod(cls, @selector(initWithRequest:delegate:startImmediately:),
                         (IMP)ab_hook_NSURLConnection_initWithRequest_start,
                         (IMP *)&ab_orig_NSURLConnection_initWithRequest_start);

    cls = NSClassFromString(@"WKWebView");
    ABHookInstanceMethod(cls, @selector(loadRequest:),
                         (IMP)ab_hook_WKWebView_loadRequest,
                         (IMP *)&ab_orig_WKWebView_loadRequest);

    cls = NSClassFromString(@"UIWebView");
    ABHookInstanceMethod(cls, @selector(loadRequest:),
                         (IMP)ab_hook_UIWebView_loadRequest,
                         (IMP *)&ab_orig_UIWebView_loadRequest);

    cls = NSClassFromString(@"UIWindow");
    ABHookInstanceMethod(cls, @selector(makeKeyAndVisible),
                         (IMP)ab_hook_UIWindow_makeKeyAndVisible,
                         (IMP *)&ab_orig_UIWindow_makeKeyAndVisible);
    ABHookInstanceMethod(cls, @selector(becomeKeyWindow),
                         (IMP)ab_hook_UIWindow_becomeKeyWindow,
                         (IMP *)&ab_orig_UIWindow_becomeKeyWindow);
}

// ============================================================
// 启动
// ============================================================

__attribute__((constructor))
static void ABInitialize(void)
{
    @autoreleasepool {
        [ABConfig shared];
        [ABLogStore shared];

        ABInstallHooks();

        NSNotificationCenter *center = [NSNotificationCenter defaultCenter];

        [center addObserverForName:UIApplicationDidBecomeActiveNotification
                            object:nil
                             queue:[NSOperationQueue mainQueue]
                        usingBlock:^(NSNotification *note) {
            ABStartGestureWindowIfNeeded();
        }];

        [center addObserverForName:UIWindowDidBecomeKeyNotification
                            object:nil
                             queue:[NSOperationQueue mainQueue]
                        usingBlock:^(NSNotification *note) {
            UIWindow *window = note.object;
            if (gGestureActive) {
                ABInstallGestureOnWindow(window);
            } else {
                ABStartGestureWindowIfNeeded();
            }
        }];

        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            ABBootScan();
        });
    }
}
