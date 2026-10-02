/** Image assets (`@assets/images/*.png`): Metro hands them over as a module id that `Image` takes as its source. */
declare module '*.png' {
  const source: number;
  export default source;
}
