# CTT.AY - Design Guidelines

## Design Approach

**Selected Framework:** Material Design (Mobile-First)
**Rationale:** Content-focused utility app requiring exceptional readability, clear visual feedback, and mobile optimization. Material Design's emphasis on content hierarchy, responsive components, and touch-friendly interactions perfectly suits this real-time transcription tool.

## Core Design Principles

1. **Readability First:** Large, legible typography for extended reading during sermons
2. **Minimal Distraction:** Clean interface that doesn't compete with the spiritual/educational content
3. **Instant Feedback:** Clear visual indicators for recording, processing, and translation states
4. **One-Handed Operation:** All controls accessible within thumb reach on mobile devices

## Typography System

**Primary Font:** Roboto (via Google Fonts CDN)
**Secondary Font:** Roboto Mono (for technical status indicators)

Hierarchy:
- App Title: text-xl font-medium (24px)
- Transcribed Text: text-lg font-normal leading-relaxed (18px, generous line height)
- Translated Text: text-base font-normal leading-relaxed (16px)
- Controls/Labels: text-sm font-medium (14px)
- Status Indicators: text-xs font-mono (12px)

## Layout System

**Spacing Units:** Tailwind units of 2, 4, 6, and 8 (e.g., p-4, mb-6, gap-8)
**Mobile Container:** Full width with px-4 side padding
**Content Max Width:** No max-width constraint (full mobile screen usage)

Vertical Structure:
- Header: py-4 (fixed position, minimal height)
- Control Panel: p-4 (language selector, recording button)
- Transcription Display: flex-1 (takes remaining viewport height)
- Bottom Padding: pb-20 (safe area for mobile devices)

## Component Library

### Header Bar
- Sticky positioning at top
- App title centered
- Minimal height (h-14)
- Subtle bottom border for separation

### Control Panel
- Language selector: Full-width dropdown with large touch target (h-12)
- Record button: Large circular FAB (floating action button), h-16 w-16
- Position: Centered, prominent placement
- Visual states: Idle (outline), Recording (filled with pulse animation), Processing (spinner)

### Transcription Display Area
- Two distinct sections with clear visual separation:
  1. Original Transcription (top section)
  2. Translated Text (bottom section)
- Each section includes:
  - Small label header (e.g., "Original" / "Translation")
  - Scrollable text container with generous padding (p-6)
  - Auto-scroll to latest content
  - Subtle divider between sections

### Text Containers
- Rounded corners: rounded-lg
- Internal padding: p-6
- Minimum height: min-h-[120px] per section
- Overflow: Auto-scroll with smooth scrolling behavior

### Recording Indicator
- Small pill-shaped badge
- Positioned near top-right of header
- Pulsing animation when active
- Text: "Recording" with dot indicator

### Language Selector
- Native select dropdown with custom styling
- Common languages: English, Spanish, French, German, Portuguese, Italian, Chinese, Arabic, Hindi
- Large touch target: h-12
- Border radius: rounded-lg

## Interaction Patterns

**Recording Flow:**
1. User taps large circular record button
2. Button fills, pulses gently
3. "Recording" badge appears
4. Text begins appearing in transcription area
5. Translation appears shortly after with subtle fade-in

**Visual Feedback:**
- Record button: Scale transform on press (scale-95)
- Processing state: Gentle rotating spinner overlay
- New text: Fade-in effect (duration-300)
- Language change: Brief loading state

## Spacing & Rhythm

**Vertical Spacing:**
- Between header and controls: mb-6
- Between control elements: gap-4
- Between transcription sections: gap-6
- Text content padding: p-6

**Horizontal Spacing:**
- Screen edges: px-4
- Between grouped elements: gap-2
- Button internal padding: px-6

## Icons

**Icon Library:** Material Icons (via CDN)
**Usage:**
- Microphone icon for record button
- Globe icon for language selector
- Alert icon for error states

## Accessibility

- Minimum touch target: 44x44px for all interactive elements
- High contrast text (WCAG AA compliant)
- Clear focus indicators for keyboard navigation
- ARIA labels for recording states
- Screen reader announcements for transcription updates

## Mobile Optimization

- Fixed header to maintain context while scrolling
- Sticky control panel for easy access
- Safe area consideration for notched devices (pb-20)
- Landscape mode: Side-by-side layout for original/translation
- Portrait mode: Stacked layout (primary use case)

## Performance Considerations

- Virtualized scrolling for long transcriptions
- Debounced text updates to prevent UI jank
- Lazy loading of translation display
- Minimal animations (only for state changes)

## No Images Required

This is a functional utility application with no hero images or decorative graphics. Focus remains entirely on text clarity and control accessibility.