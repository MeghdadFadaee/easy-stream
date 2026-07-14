import { mount } from '@vue/test-utils'

import BrandMark from './BrandMark.vue'

describe('BrandMark', () => {
  it('keeps SVG paint references unique across multiple instances', () => {
    const wrapper = mount({
      components: { BrandMark },
      template: '<div><BrandMark /><BrandMark /></div>',
    })
    const ids = wrapper.findAll('linearGradient').map((gradient) => gradient.attributes('id'))

    expect(new Set(ids).size).toBe(4)
    expect(wrapper.findAll('svg')).toHaveLength(2)
    expect(wrapper.findAll('svg').every((svg) => svg.attributes('aria-hidden') === 'true')).toBe(true)
  })
})
