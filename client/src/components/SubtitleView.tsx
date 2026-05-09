interface SubtitleViewProps {
  current: string;
  previous: string;
  isRTL?: boolean;
}

export default function SubtitleView({ current, previous, isRTL = false }: SubtitleViewProps) {
  return (
    <div className="relative h-full flex flex-col items-center justify-end px-6 pb-6 text-center">
      {/* Subtle gradient fade at bottom for cinematic effect */}
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background/60 to-transparent pointer-events-none" />

      <div className="relative z-10 max-w-2xl w-full space-y-3">
        {previous ? (
          <p
            className="text-base leading-relaxed text-muted-foreground/70 transition-opacity duration-500"
            dir={isRTL ? 'rtl' : 'ltr'}
          >
            {previous}
          </p>
        ) : (
          <div className="h-6" />
        )}

        {current ? (
          <p
            className="text-[1.6rem] font-medium leading-snug text-foreground transition-all duration-300"
            dir={isRTL ? 'rtl' : 'ltr'}
          >
            {current}
          </p>
        ) : (
          <p className="text-lg text-muted-foreground/50 italic">
            Translation will appear here…
          </p>
        )}
      </div>
    </div>
  );
}
