// Ambient types for the pure-js jpeg encoder (no bundled types).
declare module 'jpeg-js' {
  export interface RawImageData {
    data: Buffer;
    width: number;
    height: number;
  }
  export interface EncodedImage {
    data: Buffer;
    width: number;
    height: number;
  }
  export function encode(img: RawImageData, quality?: number): EncodedImage;
  export function decode(data: Buffer): RawImageData;
}
