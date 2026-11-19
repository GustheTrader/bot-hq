---
version: alpha
name: Bot HQ
description: A calm operational workspace where people supervise a distinctive team of AI agents.
colors:
  primary: "#1C1C1C"
  secondary: "#626262"
  tertiary: "#1E86FC"
  neutral: "#FCFCFC"
  canvas: "#F5F5F5"
  surface: "#FFFFFF"
  border: "#1C1C1C1F"
  text-primary: "#1C1C1C"
  text-secondary: "#626262"
  success: "#00854A"
  warning: "#AA6300"
  danger: "#CD2834"
  bot-pink: "#C82779"
  bot-blue: "#1E86FC"
  bot-red: "#FB2B3E"
  bot-orange: "#C54C00"
  bot-yellow: "#AA6300"
  bot-green: "#00854A"
  bot-teal: "#007F70"
  bot-purple: "#7040CF"
  dark-canvas: "#121212"
  dark-surface: "#1F1F1F"
  dark-text-primary: "#F5F5F5"
  dark-text-secondary: "#AAAAAA"
typography:
  h1:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  h2:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: 1.0625rem
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.01em"
  body-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: 0.9375rem
    fontWeight: 425
    lineHeight: 1.47
    letterSpacing: "0.01em"
  body-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: 0.8125rem
    fontWeight: 425
    lineHeight: 1.38
    letterSpacing: "0.015em"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "0.01em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.54
rounded:
  sm: 8px
  md: 12px
  lg: 18px
  xl: 22px
  card: 24px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    typography: "{typography.body-md}"
    rounded: "{rounded.full}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "#363636"
    textColor: "{colors.neutral}"
    typography: "{typography.body-md}"
    rounded: "{rounded.full}"
    padding: 12px
  button-agent:
    backgroundColor: "{colors.bot-pink}"
    textColor: "#FFFFFF"
    typography: "{typography.body-md}"
    rounded: "{rounded.full}"
    padding: 12px
  button-agent-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    typography: "{typography.body-md}"
    rounded: "{rounded.full}"
    padding: 12px
  chat-bubble-user:
    backgroundColor: "{colors.bot-pink}"
    textColor: "#FFFFFF"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 12px
  chat-bubble-agent:
    backgroundColor: "#1C1C1C0F"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 12px
  status-success:
    backgroundColor: "{colors.success}"
    rounded: "{rounded.full}"
    size: 6px
  status-warning:
    backgroundColor: "{colors.warning}"
    rounded: "{rounded.full}"
    size: 6px
  status-danger:
    backgroundColor: "{colors.danger}"
    rounded: "{rounded.full}"
    size: 6px
---

## Overview

Bot HQ is an operational workspace for supervising an AI team. The visual language is quiet and precise: a near-monochrome shell creates a stable surface for conversation, progress, and decisions. Each agent supplies the emotional color, through its avatar and assigned accent, without changing the information architecture.

The product should feel dependable, legible, and present. Operational state is communicated through concise copy, placement, and semantic status colors before animation or decoration.

## Colors

- **Neutral workspace:** `neutral`, `canvas`, and `surface` separate the app shell, sidebar, and panels with subtle tonal shifts. Borders should be thin and low contrast; avoid heavy card outlines.
- **Ink hierarchy:** Use `text-primary` for active content and `text-secondary` for metadata. Do not use pale gray for information needed to complete a task.
- **Agent identity:** Give every bot one accent from the `bot-*` palette. Apply it to that bot's avatar details, user-message bubbles, the send action, and only small high-emphasis moments. Keep workspace chrome neutral.
- **Semantic state:** Use `success`, `warning`, and `danger` only for completion, attention, and failure. Pair each color with text or an icon so state is not color-only.
- **Dark mode:** Use `dark-canvas`, `dark-surface`, `dark-text-primary`, and `dark-text-secondary`. In dark mode, replace elevation shadows with a fine light border.

## Typography

Use the system-first sans stack throughout the operational UI. It should look native on macOS, Windows, and Linux, load instantly, and stay highly legible in dense panels.

`body-md` is the default for conversation. `body-sm` and `label` support tool steps, timestamps, settings labels, and metadata. Use `mono` only for code, models, identifiers, and structured tool input. Keep headings compact; the screen's hierarchy should come from panel layout and spacing rather than oversized type.

## Layout

The desktop app uses three persistent regions: a 350px team rail, a flexible conversation column, and a 360px details panel. Preserve a minimum useful chat width of 424px. Align conversation content in a centered column up to 960px wide.

Use the 4px spacing scale. Keep 16px as the normal panel and composer inset, 12px between related controls, and 24px for a clear change of context. Favor full-height panels and direct dividers over excessive floating cards.

## Elevation & Depth

Light mode uses one restrained layer of elevation for floating controls, composers, and popovers. Cards use a hairline edge and a short, soft shadow. Do not stack multiple shadows or use blur to establish structure.

Dark mode is flatter. Distinguish raised surfaces with `dark-surface`, a 0.5px light edge, and spacing rather than a drop shadow.

## Shapes

Rows and small controls use the medium radius. Chat bubbles use the large radius, with one square-ish corner to retain conversational direction. Composer and high-touch actions use the extra-large or full radius. Settings cards use the card radius. Avoid mixing sharp rectangles with soft components in the same panel.

## Components

`button-primary` is reserved for a decisive workspace action. `button-agent` carries the selected agent's assigned accent; its accent must be substituted for that agent rather than treating pink as a global brand action.

The user bubble shares the selected agent accent, while the agent bubble remains neutral. Tool progress stays compact and text-led: a small semantic dot, a short active sentence, elapsed time, and an expandable record. Always preserve the explicit failure or awaiting-approval label next to its color.

Focus rings use `tertiary` with a visible 2px outline and offset. Every icon-only control needs an accessible label and a target at least 36px square.

## Do's and Don'ts

**Do** let agent avatars provide character, use motion only to clarify active work, and make approvals and failures obvious at a glance.

**Do** keep the central conversation visually dominant, leaving the rail and details panel quieter.

**Don't** use a bot accent for unrelated destructive or warning actions.

**Don't** hide operational status in hover-only UI, animation, or low-contrast placeholder text.

**Don't** add colorful gradients, decorative dashboards, or deeply layered cards to the core workspace.
