/**
 * `three` 的替身。
 *
 * AIFISHER 里 three 只用在「图片裁剪」面板的全景球贴图（CanvasPanoramaScene）上，
 * 为了它把 three（~600KB）+ @react-three/fiber + @react-three/drei（~1MB+）打进插件包里
 * 不划算。构建时用 tsdown alias 把 three/@react-three/* 指到这里：
 *   - 类型和常量照原样导出，保证 CanvasImageCrop 的依赖注入不炸；
 *   - 真正的 3D 画面组件在 stubs/react-three-fiber.tsx 里退化成一个空 div。
 * 全景预览功能因此不可用（提示占位），其余裁剪/批注/合成功能不受影响。
 */
export class Vector2 {
  x: number;
  y: number;
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  set(x: number, y: number) {
    this.x = x;
    this.y = y;
    return this;
  }
}

/** three 的 tone mapping 常量：NoToneMapping === 0 */
export const NoToneMapping = 0;
/** three 的色彩空间常量：SRGBColorSpace === 'srgb' */
export const SRGBColorSpace = 'srgb';
/** three 的贴图面常量：BackSide === 1（原值为 1，ThinSide=0/DoubleSide=2 之外的背面） */
export const BackSide = 1;
export const FrontSide = 0;
export const DoubleSide = 2;
