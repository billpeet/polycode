import { useRef } from 'react'

interface BackdropCloseHandlers {
  onClick: (event: React.MouseEvent<HTMLElement>) => void
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
}

export function useBackdropClose(onClose: () => void): BackdropCloseHandlers {
  const pointerStartedOnBackdropRef = useRef(false)

  function onPointerDown(event: React.PointerEvent<HTMLElement>) {
    pointerStartedOnBackdropRef.current = event.target === event.currentTarget
  }

  function onClick(event: React.MouseEvent<HTMLElement>) {
    const shouldClose = pointerStartedOnBackdropRef.current && event.target === event.currentTarget
    pointerStartedOnBackdropRef.current = false
    if (shouldClose) onClose()
  }

  return { onClick, onPointerDown }
}
