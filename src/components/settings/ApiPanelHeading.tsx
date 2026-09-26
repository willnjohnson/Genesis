import type { ReactNode } from "react";
import { CircleDollarSign, ExternalLink } from "lucide-react";
import { openExternalUrl } from "../../api";

/** Each provider's own guide to getting an API key: official documentation, so it stays right when the steps change. */
export const API_GUIDES = {
    youtube: { url: "https://developers.google.com/youtube/v3/getting-started" },
    pixabay: { url: "https://pixabay.com/api/docs" },
    venice: {
        url: "https://docs.venice.ai/guides/getting-started/generating-api-key",
        costNote: "Needs a funded Venice account: calls to its models are paid from your balance.",
    },
} as const;

interface HowToProps {
    /** The provider's own guide to getting an API key. */
    guideUrl: string;
    /** A small icon with this hover text next to the guide link, for something worth knowing before
     *  following it (Venice: the account needs funding). */
    costNote?: string;
}

/** The small "How to Set Up" link to a provider's guide, with its optional cost-note icon. Sits at the right
 *  of an API key heading, in Settings and in the Photosynthesis panel alike. */
export function HowToSetUp({ guideUrl, costNote }: HowToProps) {
    return (
        <span className="flex items-center gap-1.5 shrink-0">
            {costNote && (
                <span title={costNote} aria-label={costNote} className="text-amber-400 cursor-help self-center">
                    <CircleDollarSign className="w-3.5 h-3.5" />
                </span>
            )}
            <button
                type="button"
                onClick={() => { void openExternalUrl(guideUrl); }}
                title={guideUrl}
                // The dotted line is a border under the whole button, not text-decoration, so it runs under the icon too.
                className="flex items-center gap-1 pb-px text-[11px] text-[#aaaaaa] hover:text-white border-b border-dotted border-current transition-colors cursor-pointer"
            >
                <ExternalLink className="w-3 h-3 shrink-0" />
                How to Set Up
            </button>
        </span>
    );
}

interface Props {
    title: string;
    guideUrl: string;
    costNote?: string;
    children?: ReactNode;
}

/** An API key page's heading, with a small right-aligned "How to Set Up" link to the provider's guide. */
export function ApiPanelHeading({ title, guideUrl, costNote }: Props) {
    return (
        <div className="flex items-baseline justify-between gap-3 mb-1">
            <h3 className="text-base font-bold">{title}</h3>
            <HowToSetUp guideUrl={guideUrl} costNote={costNote} />
        </div>
    );
}
