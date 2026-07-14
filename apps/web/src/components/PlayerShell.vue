<script setup lang="ts">
import vazirmatnArabicUrl from '@fontsource/vazirmatn/files/vazirmatn-arabic-400-normal.woff2?url'
import vazirmatnLatinUrl from '@fontsource/vazirmatn/files/vazirmatn-latin-400-normal.woff2?url'
import Hls, { Events, type ErrorData } from 'hls.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import { api } from '@/api/client'
import { useSpatialNavigation } from '@/composables/spatial-navigation'
import { useI18n } from '@/i18n'
import { readProgress, writeProgress } from '@/storage/viewer-db'
import { type PlayRequest, usePlayerStore } from '@/stores/player'
import { useUiStore } from '@/stores/ui'
import type {
  ClientCapabilities,
  PlaybackAudioTrack,
  PlaybackSession,
  PlaybackSubtitleTrack,
  SubtitleDelivery,
} from '@/types'

type ViewState = 'IDLE' | 'REQUESTING' | 'PREPARING' | 'BUFFERING' | 'PLAYING' | 'UNSUPPORTED' | 'FAILED'
type AssRenderer = { destroy: () => void; ready?: Promise<unknown> }

const shell = ref<HTMLElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const player = usePlayerStore()
const ui = useUiStore()
const { t } = useI18n()
const state = ref<ViewState>('IDLE')
const message = ref('')
const reasonCode = ref('')
const preparationProgress = ref<number | undefined>()
const paused = ref(true)
const needsGesture = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const buffered = ref(0)
const controlsVisible = ref(true)
const menu = ref<'subtitles' | 'audio' | 'quality' | null>(null)
const session = ref<PlaybackSession | null>(null)
const selectedSubtitle = ref('off')
const selectedAudio = ref('')
const subtitleDelivery = ref<SubtitleDelivery>('OFF')
const currentRequest = ref<PlayRequest | null>(null)
const fullscreen = ref(false)
const rootVisible = computed(() => player.visible)
const isBusy = computed(() => state.value === 'REQUESTING' || state.value === 'PREPARING' || state.value === 'BUFFERING')
const canSeek = computed(() => Number.isFinite(duration.value) && duration.value > 0)

let hls: Hls | undefined
let assRenderer: AssRenderer | undefined
let requestController: AbortController | undefined
let requestSequence = 0
let hideControlsTimer: ReturnType<typeof setTimeout> | undefined
let lastProgressWrite = 0
let returnFocus: HTMLElement | null = null

function supportsAssRendering(): boolean {
  if (typeof window === 'undefined') return false
  const videoPrototype = typeof HTMLVideoElement === 'undefined' ? undefined : HTMLVideoElement.prototype
  return typeof WebAssembly !== 'undefined'
    && typeof TextDecoder !== 'undefined'
    && typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof fetch !== 'undefined'
    && Boolean(videoPrototype && ('requestVideoFrameCallback' in videoPrototype || 'getVideoPlaybackQuality' in videoPrototype))
}

function detectClientCapabilities(element: HTMLVideoElement): ClientCapabilities {
  const nativeHls = Boolean(
    element.canPlayType('application/vnd.apple.mpegurl')
    || element.canPlayType('application/x-mpegURL'),
  )
  const mse = typeof MediaSource !== 'undefined'
  const codec = 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'
  const h264Aac = mse && typeof MediaSource.isTypeSupported === 'function'
    ? MediaSource.isTypeSupported(codec)
    : nativeHls
  return {
    nativeHls,
    mse,
    hlsJs: Hls.isSupported(),
    assRenderer: supportsAssRendering(),
    supportedCodecs: h264Aac ? ['avc1.64001f', 'mp4a.40.2'] : [],
    ...(typeof navigator !== 'undefined' && navigator.userAgent ? { userAgent: navigator.userAgent.slice(0, 512) } : {}),
  }
}

function destroyAssRenderer() {
  try {
    assRenderer?.destroy()
  } catch {
    // Renderer teardown is best effort when a worker has already failed.
  }
  assRenderer = undefined
}

function removeExternalTracks() {
  const element = video.value
  if (!element) return
  element.querySelectorAll('track[data-easy-stream]').forEach((track) => track.remove())
}

function destroyMedia(clearSource = true) {
  hls?.destroy()
  hls = undefined
  destroyAssRenderer()
  removeExternalTracks()
  if (clearSource && video.value) {
    video.value.pause()
    video.value.removeAttribute('src')
    video.value.load()
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

function recordClientEvent(name: string, details: Record<string, unknown> = {}) {
  void api.clientEvent({
    name,
    mediaItemId: currentRequest.value?.mediaItemId,
    sessionId: session.value?.id,
    occurredAt: new Date().toISOString(),
    details,
  }).catch(() => undefined)
}

async function saveProgress(force = false) {
  const element = video.value
  const request = currentRequest.value
  if (!element || !request || !Number.isFinite(element.duration) || element.duration <= 0) return
  const now = Date.now()
  if (!force && now - lastProgressWrite < 10_000) return
  lastProgressWrite = now
  const ratio = element.currentTime / element.duration
  await writeProgress({
    mediaItemId: request.mediaItemId,
    positionSeconds: Math.max(0, element.currentTime),
    durationSeconds: element.duration,
    updatedAt: now,
    completed: ratio >= 0.95,
  })
}

function updateTimeline() {
  const element = video.value
  if (!element) return
  currentTime.value = Number.isFinite(element.currentTime) ? element.currentTime : 0
  duration.value = Number.isFinite(element.duration) ? element.duration : session.value?.durationSeconds ?? 0
  if (element.buffered.length && duration.value > 0) {
    buffered.value = (element.buffered.end(element.buffered.length - 1) / duration.value) * 100
  }
  void saveProgress()
}

function showControls() {
  controlsVisible.value = true
  if (hideControlsTimer) clearTimeout(hideControlsTimer)
  if (!paused.value && !menu.value) {
    hideControlsTimer = setTimeout(() => {
      controlsVisible.value = false
    }, 4_000)
  }
}

async function requestFullscreen() {
  const element = shell.value
  if (!element || !document.fullscreenEnabled || document.fullscreenElement) return
  try {
    await element.requestFullscreen({ navigationUI: 'hide' })
  } catch {
    // Fullscreen is opportunistic; the fixed player still fills the viewport.
  }
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    try { await document.exitFullscreen() } catch { /* browser is already leaving fullscreen */ }
    return
  }
  await requestFullscreen()
}

async function applyResumePosition() {
  const element = video.value
  const request = currentRequest.value
  if (!element || !request) return
  const progress = await readProgress(request.mediaItemId)
  if (!progress || progress.completed || progress.positionSeconds < 60) return
  const knownDuration = Number.isFinite(element.duration) ? element.duration : progress.durationSeconds
  if (knownDuration > 0 && progress.positionSeconds / knownDuration < 0.95) {
    element.currentTime = Math.min(progress.positionSeconds, Math.max(0, knownDuration - 2))
  }
}

async function beginPlayback() {
  const element = video.value
  if (!element) return
  await applyResumePosition()
  try {
    await element.play()
    needsGesture.value = false
  } catch {
    needsGesture.value = true
    showControls()
  }
}

function selectHlsAudio(language: string) {
  if (!hls) return
  const index = hls.audioTracks.findIndex((track) => track.lang === language || track.name === language)
  if (index >= 0) hls.audioTrack = index
}

function selectNativeAudio(language: string) {
  const element = video.value as (HTMLVideoElement & { audioTracks?: { length: number; [index: number]: { language: string; enabled: boolean } } }) | null
  if (!element?.audioTracks) return
  for (let index = 0; index < element.audioTracks.length; index += 1) {
    const track = element.audioTracks[index]
    if (track) track.enabled = track.language === language
  }
}

async function chooseAudio(track: PlaybackAudioTrack) {
  selectedAudio.value = track.id
  selectHlsAudio(track.language)
  selectNativeAudio(track.language)
  await ui.setAudioLanguage(track.language)
  menu.value = null
}

function enableVtt(track: PlaybackSubtitleTrack): boolean {
  const element = video.value
  if (!element || !track.vttUrl) return false
  removeExternalTracks()
  const trackElement = document.createElement('track')
  trackElement.dataset.easyStream = 'true'
  trackElement.kind = 'subtitles'
  trackElement.src = track.vttUrl
  trackElement.srclang = track.language
  trackElement.label = track.label
  trackElement.default = true
  element.append(trackElement)
  trackElement.addEventListener('load', () => {
    if (trackElement.track) trackElement.track.mode = 'showing'
  }, { once: true })
  subtitleDelivery.value = 'WEBVTT'
  return true
}

async function enableAss(track: PlaybackSubtitleTrack): Promise<boolean> {
  const element = video.value
  if (!element || !track.assUrl || !supportsAssRendering()) return false
  try {
    const { default: JASSUB } = await import('jassub')
    const renderer = new JASSUB({
      video: element,
      subUrl: track.assUrl,
      fonts: [...new Set([...track.fonts, vazirmatnArabicUrl, vazirmatnLatinUrl])],
      defaultFont: 'Vazirmatn',
      queryFonts: 'local',
    }) as AssRenderer
    if (renderer.ready) await renderer.ready
    assRenderer = renderer
    subtitleDelivery.value = 'ASS_JASSUB'
    return true
  } catch (error) {
    recordClientEvent('subtitle_fallback', { reason: error instanceof Error ? error.message : 'JASSUB_INIT_FAILED' })
    return false
  }
}

async function chooseSubtitle(track?: PlaybackSubtitleTrack) {
  destroyAssRenderer()
  removeExternalTracks()
  if (!track) {
    selectedSubtitle.value = 'off'
    subtitleDelivery.value = 'OFF'
    menu.value = null
    return
  }

  selectedSubtitle.value = track.id
  const renderedAss = await enableAss(track)
  if (!renderedAss && !enableVtt(track)) {
    selectedSubtitle.value = 'off'
    subtitleDelivery.value = 'OFF'
  } else {
    await ui.setSubtitleLanguage(track.language)
  }
  menu.value = null
}

function preferredSubtitle(tracks: PlaybackSubtitleTrack[]): PlaybackSubtitleTrack | undefined {
  return tracks.find((track) => track.language === ui.preferences.subtitleLanguage)
    ?? tracks.find((track) => track.default && !track.forced)
    ?? tracks.find((track) => track.language === 'fa' || track.language.startsWith('fa-'))
    ?? tracks.find((track) => track.language === 'en' || track.language.startsWith('en-'))
}

function preferredAudio(tracks: PlaybackAudioTrack[]): PlaybackAudioTrack | undefined {
  return tracks.find((track) => track.language === ui.preferences.audioLanguage)
    ?? tracks.find((track) => track.default)
    ?? tracks[0]
}

async function onManifestReady() {
  const activeSession = session.value
  if (!activeSession) return
  state.value = 'PLAYING'
  const audio = preferredAudio(activeSession.audioTracks)
  if (audio) await chooseAudio(audio)
  const subtitle = preferredSubtitle(activeSession.subtitles)
  await chooseSubtitle(subtitle)
  await beginPlayback()
  recordClientEvent('playback_started', { subtitleDelivery: subtitleDelivery.value })
}

function failPlayback(error: ErrorData | string) {
  const detail = typeof error === 'string' ? error : `${error.type}:${error.details}`
  state.value = 'FAILED'
  message.value = detail
  reasonCode.value = 'PLAYER_ERROR'
  needsGesture.value = false
  recordClientEvent('fatal_player_error', { detail })
}

function attachManifest(activeSession: PlaybackSession) {
  const element = video.value
  if (!element || !activeSession.manifestUrl) {
    failPlayback(activeSession.reasonCode ?? 'MANIFEST_URL_MISSING')
    return
  }
  state.value = 'BUFFERING'
  session.value = activeSession
  duration.value = activeSession.durationSeconds ?? 0
  const capabilities = detectClientCapabilities(element)
  element.volume = ui.preferences.volume
  element.muted = ui.preferences.muted

  if (capabilities.nativeHls) {
    element.src = activeSession.manifestUrl
    element.addEventListener('loadedmetadata', () => void onManifestReady(), { once: true })
    element.addEventListener('error', () => failPlayback('NATIVE_HLS_ERROR'), { once: true })
    element.load()
    return
  }

  if (!capabilities.hlsJs) {
    state.value = 'UNSUPPORTED'
    reasonCode.value = 'MSE_UNAVAILABLE'
    return
  }

  hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 60,
    maxBufferLength: 30,
    manifestLoadingTimeOut: 20_000,
    fragLoadingTimeOut: 30_000,
    xhrSetup: (xhr) => { xhr.withCredentials = true },
  })
  hls.on(Events.MEDIA_ATTACHED, () => hls?.loadSource(activeSession.manifestUrl!))
  hls.on(Events.MANIFEST_PARSED, () => void onManifestReady())
  hls.on(Events.AUDIO_TRACKS_UPDATED, () => {
    const audio = preferredAudio(activeSession.audioTracks)
    if (audio) selectHlsAudio(audio.language)
  })
  hls.on(Events.ERROR, (_event, data) => {
    if (data.fatal) failPlayback(data)
  })
  hls.attachMedia(element)
}

async function resolveSession(initial: PlaybackSession, sequence: number, signal: AbortSignal) {
  let active = initial
  while (active.state === 'PREPARING' && sequence === requestSequence) {
    session.value = active
    state.value = 'PREPARING'
    preparationProgress.value = active.progress
    message.value = active.message ?? ''
    await wait(active.pollAfterMs, signal)
    active = await api.playbackSession(active.id, signal)
  }
  if (sequence !== requestSequence) return
  session.value = active
  if (active.state === 'READY') {
    attachManifest(active)
  } else if (active.state === 'UNSUPPORTED_CLIENT') {
    state.value = 'UNSUPPORTED'
    reasonCode.value = active.reasonCode ?? 'UNSUPPORTED_CLIENT'
    message.value = active.message ?? ''
  } else {
    state.value = 'FAILED'
    reasonCode.value = active.reasonCode ?? 'PREPARATION_FAILED'
    message.value = active.message ?? ''
  }
}

async function start(request: PlayRequest) {
  const element = video.value
  if (!element) return
  requestSequence += 1
  const sequence = requestSequence
  requestController?.abort()
  requestController = new AbortController()
  destroyMedia()
  currentRequest.value = request
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  state.value = 'REQUESTING'
  message.value = ''
  reasonCode.value = ''
  preparationProgress.value = undefined
  needsGesture.value = false
  selectedSubtitle.value = 'off'
  selectedAudio.value = ''
  currentTime.value = 0
  duration.value = 0
  player.visible = true
  showControls()

  // Both calls happen while the card activation is still the active user gesture.
  void element.play().catch(() => undefined)
  void requestFullscreen()
  await nextTick()
  shell.value?.focus({ preventScroll: true })

  const capabilities = detectClientCapabilities(element)
  if (!capabilities.nativeHls && (!capabilities.hlsJs || capabilities.supportedCodecs.length < 2)) {
    state.value = 'UNSUPPORTED'
    reasonCode.value = 'MSE_UNAVAILABLE'
    return
  }

  try {
    const variants = (request.variants ?? []).filter((variant) => variant.available)
    const selectedVariant = request.variantId
      ? variants.find((variant) => variant.id === request.variantId)
      : variants.find((variant) => variant.height === ui.preferences.preferredQualityHeight)
        ?? variants.find((variant) => variant.isDefault)
    const initial = await api.createPlaybackSession(
      request.mediaItemId,
      capabilities,
      selectedVariant?.id,
      requestController.signal,
    )
    await resolveSession(initial, sequence, requestController.signal)
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError' || sequence !== requestSequence) return
    state.value = 'FAILED'
    message.value = error instanceof Error ? error.message : t('networkError')
    reasonCode.value = 'SESSION_REQUEST_FAILED'
  }
}

async function close() {
  requestSequence += 1
  requestController?.abort()
  await saveProgress(true)
  destroyMedia()
  state.value = 'IDLE'
  session.value = null
  currentRequest.value = null
  player.visible = false
  menu.value = null
  if (document.fullscreenElement) {
    try { await document.exitFullscreen() } catch { /* already exiting */ }
  }
  await nextTick()
  returnFocus?.focus({ preventScroll: true })
}

function togglePlayback() {
  const element = video.value
  if (!element) return
  if (element.paused) {
    void element.play().then(() => { needsGesture.value = false }).catch(() => { needsGesture.value = true })
  } else {
    element.pause()
  }
  showControls()
}

function seekBy(seconds: number) {
  const element = video.value
  if (!element || !canSeek.value) return
  element.currentTime = Math.min(element.duration, Math.max(0, element.currentTime + seconds))
  updateTimeline()
  showControls()
}

function seekTo(event: Event) {
  const element = video.value
  const target = event.target as HTMLInputElement
  if (!element || !canSeek.value) return
  element.currentTime = Number(target.value)
  updateTimeline()
}

function toggleMute() {
  const element = video.value
  if (!element) return
  element.muted = !element.muted
  void ui.setVolume(element.volume, element.muted)
}

function toggleMenu(target: 'subtitles' | 'audio' | 'quality') {
  menu.value = menu.value === target ? null : target
  showControls()
}

async function chooseQuality(variant: NonNullable<PlayRequest['variants']>[number]) {
  const request = currentRequest.value
  if (!request || session.value?.variantId === variant.id) {
    menu.value = null
    return
  }
  await saveProgress(true)
  if (variant.height) await ui.setPreferredQuality(variant.height)
  menu.value = null
  await start({ ...request, variantId: variant.id })
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remaining = Math.floor(seconds % 60)
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

function onPlayerKeydown(event: KeyboardEvent) {
  if (!rootVisible.value) return
  showControls()
  if (event.key === 'MediaPlayPause' || (event.key === ' ' && event.target === shell.value)) {
    event.preventDefault()
    togglePlayback()
  } else if (event.key === 'MediaRewind') {
    event.preventDefault()
    seekBy(-10)
  } else if (event.key === 'MediaFastForward') {
    event.preventDefault()
    seekBy(10)
  }
}

const controller = { start: (request: PlayRequest) => void start(request), close: () => void close() }
useSpatialNavigation(shell, { onBack: () => void close() })

onMounted(() => {
  player.register(controller)
  document.addEventListener('keydown', onPlayerKeydown)
  document.addEventListener('fullscreenchange', () => { fullscreen.value = Boolean(document.fullscreenElement) })
})
onBeforeUnmount(() => {
  player.unregister(controller)
  document.removeEventListener('keydown', onPlayerKeydown)
  requestController?.abort()
  destroyMedia()
})
</script>

<template>
  <section
    v-show="rootVisible"
    ref="shell"
    class="player-shell"
    :class="{ 'controls-hidden': !controlsVisible }"
    role="dialog"
    aria-modal="true"
    :aria-label="currentRequest?.title ?? t('play')"
    tabindex="-1"
    @mousemove="showControls"
    @click.self="showControls"
  >
    <video
      ref="video"
      class="player-video"
      playsinline
      preload="metadata"
      crossorigin="use-credentials"
      :poster="currentRequest?.posterUrl"
      @click="togglePlayback"
      @play="paused = false; showControls()"
      @pause="paused = true; showControls(); saveProgress(true)"
      @waiting="state = 'BUFFERING'"
      @playing="state = 'PLAYING'"
      @timeupdate="updateTimeline"
      @durationchange="updateTimeline"
      @progress="updateTimeline"
      @ended="saveProgress(true)"
      @volumechange="video && ui.setVolume(video.volume, video.muted)"
    />

    <div v-if="isBusy" class="player-status" role="status" aria-live="polite">
      <span class="spinner large" aria-hidden="true" />
      <h2>{{ state === 'PREPARING' ? t('preparing') : t('loading') }}</h2>
      <p v-if="state === 'PREPARING'">{{ message || t('preparingHint') }}</p>
      <div v-if="preparationProgress !== undefined" class="preparing-progress">
        <span :style="{ width: `${Math.min(100, Math.max(0, preparationProgress))}%` }" />
      </div>
    </div>

    <div v-else-if="state === 'UNSUPPORTED'" class="player-status player-error" role="alert">
      <span class="status-symbol" aria-hidden="true">!</span>
      <h2>{{ t('incompatibleTitle') }}</h2>
      <p>{{ message || t('incompatibleBody') }}</p>
      <small v-if="reasonCode">{{ reasonCode }}</small>
      <button class="primary-button large focus-ring" type="button" data-tv-focus @click="close">{{ t('close') }}</button>
    </div>

    <div v-else-if="state === 'FAILED'" class="player-status player-error" role="alert">
      <span class="status-symbol" aria-hidden="true">!</span>
      <h2>{{ t('playbackFailed') }}</h2>
      <p>{{ message }}</p>
      <small v-if="reasonCode">{{ reasonCode }}</small>
      <div class="hero-actions">
        <button
          v-if="currentRequest"
          class="primary-button focus-ring"
          type="button"
          data-tv-focus
          @click="start(currentRequest)"
        >{{ t('retry') }}</button>
        <button class="secondary-button focus-ring" type="button" data-tv-focus @click="close">{{ t('close') }}</button>
      </div>
    </div>

    <button
      v-if="needsGesture && state === 'PLAYING'"
      class="gesture-play focus-ring"
      type="button"
      data-tv-focus
      :aria-label="t('play')"
      @click="togglePlayback"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
      <span>{{ t('pressPlay') }}</span>
    </button>

    <div v-if="state === 'PLAYING' || state === 'BUFFERING'" class="player-topbar">
      <button class="player-icon-button focus-ring" type="button" data-tv-focus :aria-label="t('close')" @click="close">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <strong>{{ currentRequest?.title }}</strong>
    </div>

    <div v-if="state === 'PLAYING' || state === 'BUFFERING'" class="player-controls" @click.stop>
      <div class="timeline-wrap">
        <span>{{ formatTime(currentTime) }}</span>
        <div class="timeline">
          <span class="buffered" :style="{ width: `${buffered}%` }" aria-hidden="true" />
          <input
            type="range"
            data-tv-focus
            min="0"
            :max="duration || 0"
            step="0.25"
            :value="currentTime"
            :disabled="!canSeek"
            :aria-label="t('play')"
            @input="seekTo"
          />
        </div>
        <span>{{ formatTime(duration) }}</span>
      </div>

      <div class="control-row">
        <button class="player-icon-button focus-ring" type="button" data-tv-focus :aria-label="paused ? t('play') : t('pause')" @click="togglePlayback">
          <svg v-if="paused" aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          <svg v-else aria-hidden="true" viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg>
        </button>
        <button class="player-icon-button focus-ring" type="button" data-tv-focus :aria-label="t('seekBack')" @click="seekBy(-10)">
          <span aria-hidden="true">↶</span><small>10</small>
        </button>
        <button class="player-icon-button focus-ring" type="button" data-tv-focus :aria-label="t('seekForward')" @click="seekBy(10)">
          <span aria-hidden="true">↷</span><small>10</small>
        </button>
        <button class="player-icon-button focus-ring" type="button" data-tv-focus aria-label="Mute" @click="toggleMute">
          <span aria-hidden="true">{{ video?.muted ? '🔇' : '🔊' }}</span>
        </button>

        <span class="control-spacer" />

        <div v-if="currentRequest?.variants?.some((variant) => variant.available)" class="control-menu-wrap">
          <button class="player-text-button focus-ring" type="button" data-tv-focus @click="toggleMenu('quality')">{{ t('quality') }}</button>
          <div v-if="menu === 'quality'" class="track-menu">
            <button
              v-for="variant in currentRequest.variants.filter((candidate) => candidate.available)"
              :key="variant.id"
              type="button"
              data-tv-focus
              :class="{ selected: variant.id === session?.variantId }"
              @click="chooseQuality(variant)"
            >{{ variant.label }}</button>
          </div>
        </div>

        <div v-if="session?.audioTracks.length" class="control-menu-wrap">
          <button class="player-text-button focus-ring" type="button" data-tv-focus @click="toggleMenu('audio')">{{ t('audio') }}</button>
          <div v-if="menu === 'audio'" class="track-menu">
            <button
              v-for="track in session.audioTracks"
              :key="track.id"
              type="button"
              data-tv-focus
              :class="{ selected: track.id === selectedAudio }"
              @click="chooseAudio(track)"
            >{{ track.label }}</button>
          </div>
        </div>

        <div v-if="session?.subtitles.length" class="control-menu-wrap">
          <button class="player-text-button focus-ring" type="button" data-tv-focus @click="toggleMenu('subtitles')">
            {{ t('subtitles') }}
          </button>
          <div v-if="menu === 'subtitles'" class="track-menu">
            <button type="button" data-tv-focus :class="{ selected: selectedSubtitle === 'off' }" @click="chooseSubtitle()">
              {{ t('subtitleOff') }}
            </button>
            <button
              v-for="track in session.subtitles"
              :key="track.id"
              type="button"
              data-tv-focus
              :class="{ selected: track.id === selectedSubtitle }"
              @click="chooseSubtitle(track)"
            >{{ track.label }}</button>
          </div>
        </div>

        <button class="player-icon-button focus-ring" type="button" data-tv-focus :aria-label="fullscreen ? t('exitFullscreen') : t('fullscreen')" @click="toggleFullscreen">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 9V4h5M4 4l6 6m10-1V4h-5m5 0-6 6M4 15v5h5m-5 0 6-6m10 1v5h-5m5 0-6-6" /></svg>
        </button>
      </div>
    </div>
  </section>
</template>
