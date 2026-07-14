<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { ApiError, api } from '@/api/client'
import LoadingState from '@/components/LoadingState.vue'
import { useSpatialNavigation } from '@/composables/spatial-navigation'
import { useI18n } from '@/i18n'
import type { AdminDashboard } from '@/types'

const root = ref<HTMLElement | null>(null)
const checking = ref(true)
const authenticated = ref(false)
const name = ref('')
const email = ref('')
const password = ref('')
const totp = ref('')
const submitting = ref(false)
const error = ref('')
const notice = ref('')
const dashboard = ref<AdminDashboard | null>(null)
const { t } = useI18n()
const { restoreFocus } = useSpatialNavigation(root, { restoreKey: 'admin-focus' })
let controller: AbortController | undefined

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
}

async function loadDashboard() {
  controller?.abort()
  controller = new AbortController()
  error.value = ''
  try {
    dashboard.value = await api.adminDashboard(controller.signal)
    void restoreFocus()
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) {
      authenticated.value = false
      dashboard.value = null
      return
    }
    if ((reason as { name?: string }).name !== 'AbortError') {
      error.value = reason instanceof Error ? reason.message : t('networkError')
    }
  }
}

async function checkSession() {
  checking.value = true
  try {
    const session = await api.adminSession()
    authenticated.value = session.authenticated
    name.value = session.name ?? ''
    if (authenticated.value) await loadDashboard()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : t('networkError')
  } finally {
    checking.value = false
    void restoreFocus()
  }
}

async function login() {
  submitting.value = true
  error.value = ''
  try {
    await api.adminLogin(email.value.trim(), password.value, totp.value.trim() || undefined)
    authenticated.value = true
    password.value = ''
    totp.value = ''
    await loadDashboard()
  } catch (reason) {
    error.value = reason instanceof ApiError && (reason.status === 401 || reason.status === 403)
      ? t('invalidLogin')
      : reason instanceof Error ? reason.message : t('networkError')
  } finally {
    submitting.value = false
  }
}

async function logout() {
  try {
    await api.adminLogout()
  } finally {
    authenticated.value = false
    dashboard.value = null
  }
}

async function scanArchive() {
  submitting.value = true
  notice.value = ''
  error.value = ''
  try {
    await api.startScan()
    notice.value = t('scanStarted')
    await loadDashboard()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : t('networkError')
  } finally {
    submitting.value = false
  }
}

onMounted(() => void checkSession())
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div ref="root" class="page-view admin-view">
    <LoadingState v-if="checking" :label="t('loading')" />

    <section v-else-if="!authenticated" class="login-panel">
      <p class="eyebrow">Easy Stream</p>
      <h1>{{ t('loginTitle') }}</h1>
      <form @submit.prevent="login">
        <label>
          <span>{{ t('email') }}</span>
          <input v-model="email" data-tv-focus data-focus-id="admin-email" type="email" autocomplete="username" required />
        </label>
        <label>
          <span>{{ t('password') }}</span>
          <input
            v-model="password"
            data-tv-focus
            data-focus-id="admin-password"
            type="password"
            autocomplete="current-password"
            required
          />
        </label>
        <label>
          <span>{{ t('totp') }}</span>
          <input
            v-model="totp"
            data-tv-focus
            data-focus-id="admin-totp"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]*"
          />
        </label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary-button large focus-ring" data-tv-focus data-focus-id="admin-login" :disabled="submitting">
          {{ submitting ? t('loading') : t('login') }}
        </button>
      </form>
    </section>

    <template v-else>
      <section class="admin-heading">
        <div>
          <p class="eyebrow">{{ name || 'Easy Stream' }}</p>
          <h1>{{ t('dashboard') }}</h1>
        </div>
        <div class="admin-actions">
          <button class="secondary-button focus-ring" type="button" data-tv-focus @click="loadDashboard">{{ t('refresh') }}</button>
          <button
            class="primary-button focus-ring"
            type="button"
            data-tv-focus
            :disabled="submitting"
            @click="scanArchive"
          >
            {{ t('scanArchive') }}
          </button>
          <button class="text-button focus-ring" type="button" data-tv-focus @click="logout">{{ t('logout') }}</button>
        </div>
      </section>

      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>

      <section v-if="dashboard" class="dashboard-grid">
        <article class="stat-card"><span>{{ t('catalogCount') }}</span><strong>{{ dashboard.catalogCount }}</strong></article>
        <article class="stat-card"><span>{{ t('publishedCount') }}</span><strong>{{ dashboard.publishedCount }}</strong></article>
        <article class="stat-card"><span>{{ t('reviewCount') }}</span><strong>{{ dashboard.reviewCount }}</strong></article>
        <article class="stat-card"><span>{{ t('activeJobs') }}</span><strong>{{ dashboard.activeJobs }}</strong></article>
        <article class="stat-card cache-card">
          <span>{{ t('cache') }}</span>
          <strong>{{ formatBytes(dashboard.cacheUsedBytes) }}</strong>
          <small v-if="dashboard.cacheCapacityBytes">/ {{ formatBytes(dashboard.cacheCapacityBytes) }}</small>
          <progress
            v-if="dashboard.cacheUsedBytes !== undefined && dashboard.cacheCapacityBytes"
            :value="dashboard.cacheUsedBytes"
            :max="dashboard.cacheCapacityBytes"
          />
        </article>
      </section>

      <section v-if="dashboard?.jobs.length" class="jobs-panel">
        <h2>{{ t('recentJobs') }}</h2>
        <div class="jobs-table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Status</th><th>Progress</th><th>Message</th></tr></thead>
            <tbody>
              <tr v-for="job in dashboard.jobs" :key="job.id">
                <td>{{ job.type }}</td>
                <td><span class="status-pill">{{ job.state }}</span></td>
                <td>{{ job.progress === undefined ? '—' : `${Math.round(job.progress)}%` }}</td>
                <td>{{ job.message ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
