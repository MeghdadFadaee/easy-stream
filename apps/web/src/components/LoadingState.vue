<script setup lang="ts">
defineProps<{ label: string }>()
</script>

<template>
  <div class="center-state" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true" />
    <p>{{ label }}</p>
  </div>
</template>
