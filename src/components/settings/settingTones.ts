export type SettingsTone =
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'violet'

export const settingToneClass = {
  primary: {
    panel: 'border-primary/30 bg-primary/10 text-primary',
    icon: 'bg-primary/15 text-primary',
    badge: 'border-primary/40 bg-primary/10 text-primary',
    buttonSoft: 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
  },
  success: {
    panel: 'border-ok/30 bg-ok/10 text-ok',
    icon: 'bg-ok/15 text-ok',
    badge: 'border-ok/40 bg-ok/10 text-ok',
    buttonSoft: 'border-ok/40 bg-ok/10 text-ok hover:bg-ok/15 hover:text-ok',
  },
  warning: {
    panel: 'border-warn/30 bg-warn/10 text-warn',
    icon: 'bg-warn/15 text-warn',
    badge: 'border-warn/40 bg-warn/10 text-warn',
    buttonSoft: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/15 hover:text-warn',
  },
  danger: {
    panel: 'border-destructive/30 bg-destructive/10 text-error',
    icon: 'bg-destructive/15 text-error',
    badge: 'border-destructive/40 bg-destructive/10 text-error',
    buttonSoft: 'border-destructive/40 bg-destructive/10 text-error hover:bg-destructive/15 hover:text-error',
  },
  info: {
    panel: 'border-info/30 bg-info/10 text-info',
    icon: 'bg-info/15 text-info',
    badge: 'border-info/40 bg-info/10 text-info',
    buttonSoft: 'border-info/40 bg-info/10 text-info hover:bg-info/15 hover:text-info',
  },
  violet: {
    panel: 'border-primary/30 bg-primary/10 text-primary',
    icon: 'bg-primary/15 text-primary',
    badge: 'border-primary/40 bg-primary/10 text-primary',
    buttonSoft: 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
  },
  neutral: {
    panel: 'border-border bg-muted/40 text-foreground',
    icon: 'bg-muted text-muted-foreground',
    badge: 'border-border bg-muted/50 text-muted-foreground',
    buttonSoft: 'border-border bg-background hover:bg-muted hover:text-foreground',
  },
} as const
