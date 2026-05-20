import { memo } from 'react';
import { useLocalize } from '~/hooks';
import TextShimmer from '../TextShimmer';

/** Initial assistant placeholder: no bottom margin to match Container's structure and prevent CLS. */
const EmptyTextPart = memo(() => {
  const localize = useLocalize();

  return (
    <div className="text-message flex min-h-[20px] flex-col items-start gap-3 overflow-visible">
      <div className="markdown prose dark:prose-invert light w-full break-words dark:text-gray-100">
        <div aria-live="polite" aria-atomic="true">
          <TextShimmer className="text-sm font-medium">{localize('com_ui_thinking')}</TextShimmer>
        </div>
      </div>
    </div>
  );
});

export default EmptyTextPart;
