import { Svg, Polyline, Polygon, View } from "@react-pdf/renderer";

/**
 * Aayat brand constants shared across all PDF documents.
 */
export const AAYAT_PLUM = "#401634";
export const AAYAT_PLUM_500 = "#6f2a57";
export const AAYAT_MAGENTA = "#e6126e";
export const AAYAT_WEBSITE = "https://aayat.co";
export const AAYAT_FOOTER_CONTACT = "aayat.co  |  hello@aayat.co  |  +44 7727 666043";

// Geometry of the Aayat "A" mark, taken from public/brand/aayat-mark.svg
// (viewBox -13.83 30.58 206 206). Drawn as vector primitives so it stays crisp
// at any size and can be tinted/faded for a background watermark.
const MARK_VIEWBOX = "-13.83 30.58 206 206";
const MARK_OUTER = "178.35,197.16 151.53,197.16 90.22,111.47 27.52,197.16 0,197.16 90.22,70.01";
const MARK_INNER = "90.22,137.24 46.68,197.16 70.36,197.16 89.17,172.42 107.64,197.16 131.67,197.16 90.22,137.24";

/**
 * Faint, centered brand mark used as a page background watermark. Render it as
 * the FIRST child inside a <Page> with `fixed` so it repeats on every page and
 * sits behind the page content.
 */
export function PdfWatermark({ size = 320, opacity = 0.05 }: { size?: number; opacity?: number }) {
  return (
    <View
      fixed
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={{ opacity }}>
        <Svg viewBox={MARK_VIEWBOX} style={{ width: size, height: size }}>
          <Polyline points={MARK_OUTER} fill={AAYAT_PLUM_500} />
          <Polygon points={MARK_INNER} fill={AAYAT_MAGENTA} />
        </Svg>
      </View>
    </View>
  );
}
