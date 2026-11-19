/**
 * A polite status the loading view keeps mounted, so assistive technology
 * hears `label` when loading starts; the skeleton shown beside it stays
 * decorative (`aria-hidden`).
 */
export function LoadingAnnouncement({ loading, label }: { loading: boolean; label: string }) {
  return (
    <p role="status" className="sr-only">
      {loading ? label : ''}
    </p>
  )
}
