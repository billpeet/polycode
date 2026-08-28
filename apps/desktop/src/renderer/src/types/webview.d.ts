import type { WebviewTag } from 'electron'

/**
 * React knows nothing about Electron's <webview> tag; this teaches the JSX
 * registry the attributes we use. The element type is `WebviewTag` so refs
 * expose the full guest-control API (loadURL, goBack, canGoBack, ...).
 */
interface WebviewAttributes {
  src?: string
  partition?: string
  allowpopups?: boolean
  useragent?: string
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.ClassAttributes<WebviewTag> & React.HTMLAttributes<HTMLElement> & WebviewAttributes
    }
  }
}
