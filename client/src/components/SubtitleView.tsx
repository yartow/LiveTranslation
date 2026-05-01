interface SubtitleViewProps {
  current: string;
  previous: string;
  isRTL?: boolean;
}

export default function SubtitleView({ current, previous, isRTL = false }: SubtitleViewProps) {
  return (
    <div className="flex flex-col items-center justify-end h-full pb-8 px-6 text-center">
      {previous ? (
        <p
          className="text-base leading-relaxed text-muted-foreground mb-3 max-w-2xl"
          dir={isRTL ? 'rtl' : 'ltr'}
        >
          {previous}
        </p>
      ) : (
        <div className="mb-3" />
      )}
      {current ? (
        <p
          className="text-2xl font-medium leading-relaxed text-foreground max-w-2xl"
          dir={isRTL ? 'rtl' : 'ltr'}
        >
          {current}
        </p>
      ) : (
        <p className="text-lg text-muted-foreground italic">Translation will appear here...</p>
      )}
    </div>
  );
}
