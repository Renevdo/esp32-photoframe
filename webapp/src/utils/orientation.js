// Rotate and mirror for the upload preview, as the user sees them on screen:
// the picture is turned by `rotation` degrees clockwise (0, 90, 180 or 270),
// then mirrored left to right when `flipH` is set. Mirroring is the last step
// so the mirror button is a plain toggle; a quarter turn pressed while the
// picture is mirrored has to turn the unmirrored picture the other way round,
// since mirror ∘ rotate(θ) = rotate(−θ) ∘ mirror.

export const IDENTITY = Object.freeze({ rotation: 0, flipH: false });

// `quarterTurns` > 0 turns the picture on screen clockwise.
export function rotated({ rotation, flipH }, quarterTurns) {
  const degrees = 90 * quarterTurns * (flipH ? -1 : 1);
  return { rotation: (((rotation + degrees) % 360) + 360) % 360, flipH };
}

export function mirrored({ rotation, flipH }) {
  return { rotation, flipH: !flipH };
}

export function isIdentity({ rotation, flipH }) {
  return rotation === 0 && !flipH;
}

// Size of a width × height picture after `rotation`.
export function orientedSize(width, height, rotation) {
  return rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

// A copy of `source` (a canvas or image) drawn with `transform` applied, or
// `source` itself when there is nothing to do.
export function orientCanvas(source, transform) {
  if (isIdentity(transform)) return source;
  const { width, height } = orientedSize(source.width, source.height, transform.rotation);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.translate(width / 2, height / 2);
  if (transform.flipH) ctx.scale(-1, 1);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}
