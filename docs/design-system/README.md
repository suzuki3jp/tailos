# Tailos design system

The visual reference is the [Home frame](https://www.figma.com/design/8xCaWOhzVybu2PXiJ3Hrij/tailos?node-id=21-10905) and [Design Systems page](https://www.figma.com/design/8xCaWOhzVybu2PXiJ3Hrij/tailos?node-id=6-2). Treat Figma as read-only. Home is a Server Component. Profile, Projects and Sessions are prefetched in parallel for each home request and hydrated into TanStack Query before the initial render. The composer does not start a Run. See [the server prefetch decision](../pdr/records/PDR-20261117-home-server-prefetch.md).

## Ownership

- `apps/web/src/shared/styles/tokens.css`: semantic colors, typography and radii. `index.css` is the stylesheet's public entry.
- `apps/web/src/shared/ui/design-systems` defines Tailos primitives with React Aria Components, CVA variants and semantic tokens. Import the primitives from `@/shared/ui/design-systems`.
- `apps/web/src/shared/lib/cn.ts`: class merging, including Tailos's semantic font-size names. Adding a typography utility also requires registering its name here so it does not conflict with text colors.
- `apps/web/src/_pages/home`: home presentation and Session queries, with small Client boundaries for the personalized greeting, input, pagination and retry.
- `apps/web/src/widgets/page-shell`: the shared Page, Sidebar and account footer for Home, Session and management screens. The server composition is passed through the Project selection and mobile Sheet boundaries.
- `apps/web/src/features/select-project`: Project list queries, in-page selection state and the shared Project picker.
- `apps/web/src/entities/account`: the authenticated profile query shared by the sidebar and greeting.
- `apps/web/src/app/home-data.ts`: request-scoped parallel prefetch and safe dehydration, including serializable failure states. `shared/api/index.server.ts` exposes the server client that forwards only the session cookie, disables caching, and does not follow redirects. Query keys and conditions match the browser client; mounting the hydrated consumers does not repeat the initial requests.
- `apps/web/src/app/(management)`: existing public management routes, composed with the shared Page shell and a settings/connection navigation inside its content. These screens may adopt new styles, fonts and icons freely; preserving their previous appearance is not a requirement. Root login errors continue to render the account screen. See [the Web design compatibility decision](../pdr/records/PDR-20261128-web-design-compatibility.md).

## Tokens

| Figma | Token | Light value |
| --- | --- | --- |
| light-bg-primary | background | `#fffcf5` |
| light-font-primary | foreground | `#271e18` |
| light-font-secondary | muted-foreground | `#63584a` |
| light-font-link | link | `#454fb1` |
| light-border | border / input | `#ded4c3` |
| light-button-primary | primary | `#855333` |
| light-font-danger | destructive | `#a42b2b` |

Home headings and Session titles currently use black in Figma, exposed separately as `foreground-strong`. Card, popover and sidebar backgrounds alias `background`. The exported unread asset uses `#004ebb`; it is separate from Run state. The Select focus example uses `#d4d4d4` for its ring. An unlayered `:focus-visible` rule adds a solid primary outline to keyboard-focused controls, overriding the primitives' `outline-none` utilities.

Secondary, muted and hover surfaces are supplemental UI values, mixed from the existing border and background colors. They are not additional colors already specified by Figma. The theme is light-only; no dark theme is enabled.

Geist is self-hosted through the pinned Fontsource package. Font sizes / line heights are `display` 40/40, `page-title` 26/26, `section-title` 22/26.4, `body` 16/16, `caption` 14/14, `control` 14/20 and `control-xs` 12/16 pixels. HTML heading levels express document structure independently of visual size. Radii are 6, 8 and 10 pixels. Use Tailwind's spacing scale for the 4, 6, 8, 10, 12, 24, 36, 48 and 60 pixel spacing in the reference.

`paper`, `panel`, `ink`, `rule`, `signal`, `danger` and `accent-ink` are temporary aliases used by the prototype management screens. They can be migrated to the new tokens without preserving the old appearance. Old text uses of `muted` were migrated to `muted-foreground`; `muted` now means a subtle surface. Do not use legacy color names in new UI.

## Components

- **Button**: `default` for primary actions, `outline` for bordered alternatives, `ghost` for unobtrusive controls. Icon buttons need an accessible name.
- **Select**: `default` 32px, `sm` 28px, `xs` 22px, `lg` 36px. The `ghost` variant is used in the composer; the sidebar uses the bordered variant. Both controls share a selection, initially the first Project returned by the API. Choices show Project names and repositories, including later API pages. The initial choices are server-prefetched; failures and empty lists disable the controls. Selection is not persisted across reloads. It remains a non-editable Select; a searchable Combobox can be added when required.
- **InputGroup**: shared focus boundary around a textarea and a `block-end` action area. Clicking the action area must not steal focus from its Select or buttons. The composer preserves the draft and reports that preview submission did not send it.
- **Avatar**: the account footer shows the authenticated profile’s 36px avatar, name and email. Missing or failed images fall back to a generic account icon. Missing authentication offers Sign in; profile failures offer a local retry. Sample imagery is not presented as the authenticated user.
- **Dialog / Sheet**: shared dialog primitives and mobile navigation. React Aria handles Escape and focus restoration.
- **Recent Sessions**: the server renders the section and its prefetched first page; the Client list handles additional pages and retry. Rows link to actual Session details and show the API's trigger, timestamp and latest Run status. Initial timestamps use the hydrated query's update time to avoid hydration differences. Empty, login and failure states are also present on initial render. Project selection does not filter the account-wide list, and unread marks are not inferred from Run state.

The shared desktop sidebar is 240px wide, with a 60px head, 36px navigation rows, 12px icon gaps, 24px between navigation groups and a 60px account footer pinned to the viewport bottom. There is no desktop main header or border below the sidebar head. On mobile, the Sheet contains focus while open and restores focus to the navigation button on dismissal.

The root layout exposes the Worker's per-response CSP nonce through the `nonce` attribute of `meta[property="csp-nonce"]`. React Aria uses it on generated style elements. The policy allows inline style attributes for overlay positioning and limits image sources to the same origin and `https://avatars.githubusercontent.com`. The Project Select renders its current label and trigger in the initial HTML. [CSP decision](../pdr/records/PDR-20261127-react-aria-csp.md)

## Adding and using primitives

Define shared controls in `apps/web/src/shared/ui/design-systems` and export them through its `index.ts`. Use React Aria at the component boundary and Tailos tokens and CVA for styling and variants. The workspace lint rule restricts direct React Aria imports and the JSX tags `select`, `button`, `label`, `option`, `input` and `textarea` to this directory. [Design system decision](../pdr/records/PDR-20261128-design-system-form-controls.md)

Use `Button` with `onPress` for actions or `type="submit"` for form submission. Give icon-only controls an accessible name. Use `Label` with `Input` or `Textarea`, and `Checkbox` for a boolean choice. Give `Select` a visible `label` or an accessible name, and options with stable IDs and labels. Options can carry a description or belong to a named group. Use `Dialog` with a trigger and either `DialogContent` or `SheetContent`, with a title for the overlay.

Import individual icons from `@tabler/icons-react`. Use `currentColor` and explicit sizes, and hide decorative icons from assistive technology. [Icon decision](../pdr/records/PDR-20261127-design-system-icons.md)

## Session execution timeline

The session page places progress and tool activity in the conversation, immediately before the Run's final answer. An active Run starts expanded; a completed Run can be expanded from its recorded `Worked for …` summary. The final answer remains outside the history. No fabricated completion percentage or private reasoning is shown.

| Element | Appearance and behavior |
| --- | --- |
| Progress message | Plain `text-control`, relaxed line height, preserved line breaks. Completed and inspected messages arrive as a unit. No speech bubble or duplicate final answer. |
| Activity Item | `bg-card`, `border-border`, `rounded-lg`, 12px horizontal padding and 10px vertical padding. Command names use `font-mono`; other labels use the body face. Long labels wrap on narrow screens. |
| State | 16px Tabler mark with a text label. `muted-foreground` for normal states, `destructive` for failure. Running marks animate only when reduced motion is not requested. A finished Run's unfinished Item is shown as result unknown. |
| Disclosure | Shared `shared/ui/disclosure` uses native `details` / `summary`, keyboard behavior and the existing focus outline. In Run history, the chevron sits immediately after the label with a 6px gap (`gap-1.5`); other disclosures keep the chevron at the right edge. The chevron rotates on open; no custom keyboard handling or new color is introduced. |
| Output | Loaded only on expansion. `bg-muted`, `rounded-md`, `font-mono`, `text-control-xs`, 12px padding, bounded scrolling. Exit code and measured duration appear with the Item. Missing, expired and failed requests have distinct text; request failures offer Retry. |
| Connection | A small separate status distinguishes live/reconnecting/authentication from Agent execution. Saved content stays visible while reconnecting. |

The page hydrates the initial timeline alongside Session and list data. WebSocket attachment does not block rendering. History is paginated, output bodies are excluded from the initial payload, and updates change the affected Item rather than refetching the whole conversation. Auto-follow applies while the reader is at the bottom; otherwise a New activity action brings them back. The session composer continues to have submission disabled.

The first implementation streams message and tool lifecycle events. Command output becomes available on completion; character-by-character output and Agent control are later stages. See the [session display decision](../pdr/records/PDR-20261121-project-session-timeline.md), [timeline contract](../pdr/records/PDR-20261121-session-execution-timeline.md) and [transport](../pdr/records/PDR-20261121-session-realtime-transport.md).

## Session messages

Saved message bodies render Markdown with compact 18px semibold headings, 16px text and square unordered-list markers. The first list level uses solid squares and nested levels use outlined squares. Links are underlined with the `link` token on the page and the text color inside a message bubble. Inline code uses a muted monospace treatment. Code blocks can scroll horizontally within the message and use Shiki when the fence names a supported language. [Session Markdown decision](../pdr/records/PDR-20261126-session-message-markdown.md)

## Assets

Project-specific Figma imagery and decorations are downloaded under `apps/web/public/assets/design-system`. Temporary Figma asset URLs are not runtime sources. Generic icons are rendered with Tabler components instead of duplicated SVG exports.

| Asset | Figma node / slot |
| --- | --- |
| tailos-symbol.png | Page / Sidebar Head / Logo |
| demo-avatar.png | Historical preview asset; not used as the authenticated account |
| unread.svg | Card Item / Unread |
| separator.svg | Card Item / Line |

## Verification

Compare the home at 1320 × 832 with the reference: sidebar 240px with a 60px head, no desktop main header, 240px right Slot, content 640px inside 24px gutters, 72px home top padding (48px for the base Page), 140px initial composer and 60px between sections. Use minimum heights rather than clipping long content. Verify initial data without JavaScript, parallel server requests, per-request cache isolation, and no duplicate list requests on hydration, including failure cases. Check narrow screens, synchronized Project selection, Sheet dismissal and focus restoration, draft retention, Session pagination and error recovery. Home initially reads profile, Projects and Sessions in parallel. Verify account success, missing avatars, unauthorized and failed profile requests without fabricated user information. Verify built Worker output under the CSP, including GitHub avatar loading. See [the shared Page decision](../pdr/records/PDR-20261125-shared-page-shell.md).

Run the same checks as CI: `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm --filter @tailos/web run build`.
