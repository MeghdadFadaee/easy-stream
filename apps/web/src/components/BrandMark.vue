<script setup lang="ts">
import { useId } from 'vue'

const gradientId = `brand-gold-${useId()}`
const shineId = `brand-shine-${useId()}`
</script>

<template>
  <svg
    class="brand-symbol"
    viewBox="0 0 64 64"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient :id="gradientId" x1="10" y1="7" x2="54" y2="58" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFE29A" />
        <stop offset="0.46" stop-color="#F5BD43" />
        <stop offset="1" stop-color="#D98A08" />
      </linearGradient>
      <linearGradient :id="shineId" x1="16" y1="11" x2="43" y2="49" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFF5D5" stop-opacity="0.82" />
        <stop offset="1" stop-color="#FFF5D5" stop-opacity="0" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="18" fill="#111722" />
    <rect x="5" y="5" width="54" height="54" rx="15" :fill="`url(#${gradientId})`" />
    <path d="M18 20.5c0-3.04 2.46-5.5 5.5-5.5h17.75a5.5 5.5 0 0 1 4.8 2.82l5.46 9.78a9 9 0 0 1 0 8.8l-5.46 9.78a5.5 5.5 0 0 1-4.8 2.82H23.5a5.5 5.5 0 0 1-5.5-5.5v-23Z" fill="#111722" />
    <path d="m30 24.4 12.2 7.6L30 39.6V24.4Z" fill="#FFF8E8" />
    <path d="M13.5 23.5h7M11 32h9.5M13.5 40.5h7" fill="none" stroke="#111722" stroke-width="3.5" stroke-linecap="round" />
    <path d="M17 12.5h18c8 0 13.2 4.4 16 10.5" fill="none" :stroke="`url(#${shineId})`" stroke-width="2.5" stroke-linecap="round" />
  </svg>
</template>
