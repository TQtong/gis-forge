import type { ReactElement } from 'react';
import { MousePointer } from 'lucide-react';
import { EmptyState } from '@/components/common/EmptyState';
import { FeatureProperties } from '@/components/properties/FeatureProperties';
import { MultiSelectSummary } from '@/components/properties/MultiSelectSummary';
import { useSelectionStore } from '@/stores/selectionStore';

/**
 * Right-panel “属性” tab: empty state, single-feature inspector, or multi-select summary.
 *
 * @returns Property inspector content driven by `useSelectionStore`.
 */
export function PropertyTab(): ReactElement {
    const selectedFeatures = useSelectionStore((s) => s.selectedFeatures);

    if (selectedFeatures.length === 0) {
        return (
            <EmptyState
                icon={MousePointer}
                title="点击地图上的要素"
                description="查看属性信息，或使用选择工具框选多个要素"
            />
        );
    }

    if (selectedFeatures.length === 1) {
        return <FeatureProperties feature={selectedFeatures[0]} />;
    }

    return <MultiSelectSummary features={selectedFeatures} />;
}
