import type { MediaDTO, PostDTO } from '@engine/api/dto';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Platform, Pressable, Share, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { ArrowUpTrayIcon, HeartIcon, PhotoIcon, PlayIcon, XMarkIcon } from 'react-native-heroicons/outline';
import { HeartIcon as HeartSolid } from 'react-native-heroicons/solid';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { sendWrite } from '~/data/writes';
import { likeWrite } from '~/features/post/post-writes';
import { formatNumber } from '~/lib-allowlist';
import { appendLog, errorMessage } from '~/engine/logs';
import { lightImpact } from '~/ui/haptics';
import { useMediaUrls } from '~/ui/media-url';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { colors } from '~/ui/tokens';

import { findCachedPost } from './cached-post';
import { clampOffset, fittedSize, settlePage, shouldDismiss, MAX_ZOOM, DOUBLE_TAP_ZOOM } from './viewer-math';

const WHITE = colors.white;
const SPRING = { damping: 20, stiffness: 220, mass: 0.6 } as const;

/** The post the viewer was opened from, found in the cache, else read. */
function useViewerPost(postId: string) {
  return useEngineQuery<PostDTO | null>(queryKeys.post.detail(postId), (api) => api.posts.get(postId), {
    enabled: postId.length > 0,
    // The card that opened the viewer already holds the media; likes on it update optimistically.
    // No refetch at open: lib answers a failed read as "absent", which would blank the viewer.
    initialData: () => findCachedPost(postId),
  });
}

interface PageProps {
  media: MediaDTO;
  index: number;
  count: number;
  page: SharedValue<number>;
  scale: SharedValue<number>;
  offsetX: SharedValue<number>;
  offsetY: SharedValue<number>;
  width: number;
  height: number;
  onSize: (index: number, size: { width: number; height: number }) => void;
}

/** One item, fitted to the screen; the current one carries the zoom and pan. */
const ViewerPage = memo(function ViewerPage({
  media,
  index,
  count,
  page,
  scale,
  offsetX,
  offsetY,
  width,
  height,
  onSize,
}: PageProps) {
  const { media: resolve } = useMediaUrls();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const video = media.type === 'video';
  const uri = resolve(video ? media.thumbnail : media.url);
  const zoomStyle = useAnimatedStyle(() =>
    page.value === index
      ? { transform: [{ translateX: offsetX.value }, { translateY: offsetY.value }, { scale: scale.value }] }
      : { transform: [] },
  );
  const kind = video ? 'Video' : media.type === 'gif' ? 'GIF' : 'Image';
  const label = `${media.alt || kind}, ${index + 1} of ${count}`;

  let content;
  if (!uri || failed) {
    content = (
      <View className="items-center gap-3">
        {video ? <PlayIcon size={48} color={WHITE} /> : <PhotoIcon size={48} color={WHITE} />}
        <Text variant="subhead" style={{ color: WHITE }}>
          {video ? 'Video' : 'Image unavailable'}
        </Text>
      </View>
    );
  } else {
    content = (
      <>
        <Image
          source={{ uri }}
          style={{ width, height }}
          contentFit="contain"
          transition={150}
          accessible={false}
          onLoad={(e) => {
            setLoaded(true);
            onSize(index, { width: e.source.width, height: e.source.height });
          }}
          onError={() => setFailed(true)}
          testID={`media-image-${index}`}
        />
        {!loaded ? (
          <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
            <Spinner size="md" color={WHITE} />
          </View>
        ) : null}
        {video ? (
          <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
            <View className="h-16 w-16 items-center justify-center rounded-full bg-black/60">
              <PlayIcon size={32} color={WHITE} />
            </View>
          </View>
        ) : null}
      </>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width, height }}
      className="items-center justify-center"
    >
      <Animated.View style={[{ width, height, alignItems: 'center', justifyContent: 'center' }, zoomStyle]}>
        {content}
      </Animated.View>
    </View>
  );
});

function ChromeButton({
  label,
  onPress,
  children,
  testID,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      testID={testID}
      className="h-11 min-w-11 flex-row items-center justify-center gap-1.5 rounded-full bg-black/50 px-3 active:bg-black/70"
    >
      {children}
    </Pressable>
  );
}

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * The full-screen image viewer (UX_SPEC §4.35): black, the image fitted,
 * pinch to zoom (up to 4×), double-tap to zoom 2×, swipe sideways between
 * the post's items, swipe down (or up) to dismiss with the background
 * fading along. A tap shows or hides the chrome: close, "1 / 3", share and
 * the post's like button.
 */
export function MediaViewer({ postId, initialIndex }: { postId: string; initialIndex: number }) {
  const { data: post, isPending } = useViewerPost(postId);
  const count = post?.media.length ?? 0;
  if (!post || count === 0) {
    return (
      <View className="flex-1 bg-black" testID="media-viewer">
        <StatusBar style="light" />
        <View className="flex-1 items-center justify-center gap-3">
          {isPending ? (
            <Spinner size="md" color={WHITE} />
          ) : (
            <>
              <PhotoIcon size={48} color={WHITE} />
              <Text variant="subhead" style={{ color: WHITE }}>
                Image unavailable
              </Text>
            </>
          )}
        </View>
        <TopBar index={0} count={0} chrome />
      </View>
    );
  }
  const start = Math.min(Math.max(0, initialIndex), count - 1);
  return <Pager post={post} start={start} />;
}

function TopBar({
  index,
  count,
  chrome,
  chromeStyle,
}: {
  index: number;
  count: number;
  chrome: boolean;
  chromeStyle?: ComponentProps<typeof Animated.View>['style'];
}) {
  const insets = useSafeAreaInsets();
  return (
    <Animated.View
      pointerEvents={chrome ? 'box-none' : 'none'}
      style={[{ position: 'absolute', left: 0, right: 0, top: insets.top + 8 }, chromeStyle]}
      className="flex-row items-center justify-between px-4"
    >
      <ChromeButton label="Close image" onPress={close} testID="media-close">
        <XMarkIcon size={24} color={WHITE} />
      </ChromeButton>
      {count > 1 ? (
        <View className="rounded-full bg-black/50 px-3 py-1.5" testID="media-counter">
          <Text variant="subheadStrong" tabular style={{ color: WHITE }}>
            {index + 1} / {count}
          </Text>
        </View>
      ) : null}
      <View className="w-11" />
    </Animated.View>
  );
}

function Pager({ post, start }: { post: PostDTO; start: number }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const { media: resolve } = useMediaUrls();
  const items = post.media;
  const count = items.length;

  const [index, setIndex] = useState(start);
  const [chrome, setChrome] = useState(true);
  const [sizes, setSizes] = useState<Record<number, { width: number; height: number }>>({});

  const page = useSharedValue(start);
  /** The strip's offset from the current page while a swipe moves or settles it. */
  const dragX = useSharedValue(0);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const dismissY = useSharedValue(0);
  /** 0 undecided, 1 paging, 2 dismissing, 3 panning a zoomed image. */
  const axis = useSharedValue(0);
  const chromeOpacity = useSharedValue(1);
  // The fitted size of the current item, for clamping the pan.
  const fitW = useSharedValue(width);
  const fitH = useSharedValue(height);

  useEffect(() => {
    const size = sizes[index];
    const fitted = size ? fittedSize(size, { width, height }) : { width, height };
    fitW.set(fitted.width);
    fitH.set(fitted.height);
  }, [sizes, index, width, height, fitW, fitH]);

  useEffect(() => {
    chromeOpacity.set(reduceMotion ? (chrome ? 1 : 0) : withTiming(chrome ? 1 : 0, { duration: 150 }));
  }, [chrome, chromeOpacity, reduceMotion]);

  const onSize = useCallback((i: number, size: { width: number; height: number }) => {
    setSizes((current) => (current[i] ? current : { ...current, [i]: size }));
  }, []);
  const toggleChrome = useCallback(() => setChrome((shown) => !shown), []);

  const resetZoom = () => {
    'worklet';
    scale.set(withTiming(1));
    savedScale.set(1);
    offsetX.set(withTiming(0));
    offsetY.set(withTiming(0));
  };

  const goTo = (target: number, velocity: number) => {
    'worklet';
    if (target !== page.value) {
      // Keep the strip where it is on screen while the page index moves under it.
      dragX.set(dragX.value + (target - page.value) * width);
      page.set(target);
      resetZoom();
      scheduleOnRN(setIndex, target);
    }
    dragX.set(withSpring(0, { ...SPRING, velocity }));
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      savedScale.set(scale.value);
    })
    .onUpdate((e) => {
      scale.set(Math.min(MAX_ZOOM * 1.2, Math.max(0.8, savedScale.value * e.scale)));
    })
    .onEnd(() => {
      if (scale.value <= 1) {
        resetZoom();
        return;
      }
      const next = Math.min(MAX_ZOOM, scale.value);
      scale.set(withSpring(next, SPRING));
      savedScale.set(next);
      offsetX.set(withSpring(clampOffset(offsetX.value, fitW.value, width, next), SPRING));
      offsetY.set(withSpring(clampOffset(offsetY.value, fitH.value, height, next), SPRING));
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      savedX.set(offsetX.value);
      savedY.set(offsetY.value);
      axis.set(scale.value > 1.01 ? 3 : 0);
    })
    .onUpdate((e) => {
      if (axis.value === 3) {
        offsetX.set(savedX.value + e.translationX);
        offsetY.set(savedY.value + e.translationY);
        return;
      }
      if (axis.value === 0) axis.set(Math.abs(e.translationX) > Math.abs(e.translationY) ? 1 : 2);
      if (axis.value === 1) {
        const atEdge =
          (page.value === 0 && e.translationX > 0) || (page.value === count - 1 && e.translationX < 0);
        dragX.set(e.translationX * (atEdge ? 0.3 : 1));
      } else {
        dismissY.set(e.translationY);
      }
    })
    .onEnd((e) => {
      if (axis.value === 3) {
        offsetX.set(withSpring(clampOffset(offsetX.value, fitW.value, width, scale.value), SPRING));
        offsetY.set(withSpring(clampOffset(offsetY.value, fitH.value, height, scale.value), SPRING));
        return;
      }
      if (axis.value === 1) {
        goTo(settlePage(page.value, e.translationX, e.velocityX, width, count), e.velocityX);
        return;
      }
      if (shouldDismiss(e.translationY, e.velocityY)) {
        dismissY.set(
          withTiming(Math.sign(e.translationY || 1) * height, { duration: 180 }, (done) => {
            // Explicit: React Compiler hoists this closure out of the gesture, past the worklet transform.
            'worklet';
            if (done) scheduleOnRN(close);
          }),
        );
      } else {
        dismissY.set(withSpring(0, SPRING));
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      if (scale.value > 1.01) {
        resetZoom();
        return;
      }
      scale.set(withTiming(DOUBLE_TAP_ZOOM));
      savedScale.set(DOUBLE_TAP_ZOOM);
      // Zoom in on the tapped point.
      // Screen coordinates: `e.x` is measured across the whole strip of pages.
      const x = (width / 2 - e.absoluteX) * (DOUBLE_TAP_ZOOM - 1);
      const y = (height / 2 - e.absoluteY) * (DOUBLE_TAP_ZOOM - 1);
      offsetX.set(withTiming(clampOffset(x, fitW.value, width, DOUBLE_TAP_ZOOM)));
      offsetY.set(withTiming(clampOffset(y, fitH.value, height, DOUBLE_TAP_ZOOM)));
    });
  const singleTap = Gesture.Tap().onEnd(() => {
    scheduleOnRN(toggleChrome);
  });
  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.abs(dismissY.value) / (height * 0.6)),
  }));
  const stripStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: -page.value * width + dragX.value },
      { translateY: dismissY.value },
      { scale: 1 - Math.min(0.15, Math.abs(dismissY.value) / (height * 2)) },
    ],
  }));
  const chromeStyle = useAnimatedStyle(() => ({
    opacity: chromeOpacity.value * (1 - Math.min(1, Math.abs(dismissY.value) / 120)),
  }));

  const current = items[index];
  const liked = post.viewer?.liked === true;
  const likes = post.stats.likes;
  const shareUrl = current ? resolve(current.url) : undefined;

  const share = () => {
    if (!shareUrl) return;
    const content = Platform.OS === 'ios' ? { url: shareUrl } : { message: shareUrl };
    Share.share(content).catch((error: unknown) => appendLog('warn', 'host', `Share failed: ${errorMessage(error)}`));
  };
  const like = () =>
    requireAuth(() => {
      if (!liked) lightImpact();
      sendWrite(likeWrite, { post, like: !liked });
    });
  const step = (by: number) => {
    const target = Math.min(count - 1, Math.max(0, index + by));
    page.set(target);
    dragX.set(0);
    setIndex(target);
  };

  return (
    <View className="flex-1" testID="media-viewer">
      <StatusBar style="light" hidden={!chrome} animated />
      <Animated.View
        style={[{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.black }, backdropStyle]}
      />
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[{ flexDirection: 'row', width: width * count, height }, stripStyle]}
          accessibilityActions={[
            { name: 'increment', label: 'Next image' },
            { name: 'decrement', label: 'Previous image' },
          ]}
          onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        >
          {items.map((media, i) => (
            <ViewerPage
              key={`${i}:${media.url}`}
              media={media}
              index={i}
              count={count}
              page={page}
              scale={scale}
              offsetX={offsetX}
              offsetY={offsetY}
              width={width}
              height={height}
              onSize={onSize}
            />
          ))}
        </Animated.View>
      </GestureDetector>

      <TopBar index={index} count={count} chrome={chrome} chromeStyle={chromeStyle} />

      <Animated.View
        pointerEvents={chrome ? 'box-none' : 'none'}
        style={[{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 12 }, chromeStyle]}
        className="flex-row items-center justify-between px-4"
      >
        <ChromeButton label="Share image" onPress={share} testID="media-share">
          <ArrowUpTrayIcon size={22} color={WHITE} />
        </ChromeButton>
        <ChromeButton label={`${liked ? 'Unlike' : 'Like'}, ${likes} likes`} onPress={like} testID="media-like">
          {liked ? <HeartSolid size={22} color={colors.red500} /> : <HeartIcon size={22} color={WHITE} />}
          {likes > 0 ? (
            <Text variant="subheadStrong" tabular style={{ color: WHITE }}>
              {formatNumber(likes)}
            </Text>
          ) : null}
        </ChromeButton>
      </Animated.View>
    </View>
  );
}
