/** Device class for render quality choices: phones and tablets get smaller shadow maps, textures and pixel ratio. */
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
export const isMobile = params.has('mobile') ? params.get('mobile') !== '0'
    : /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
