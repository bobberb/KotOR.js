import { GFFDataType } from "@/enums/resource/GFFDataType";
import { GFFField } from "@/resource/GFFField";
import { GFFStruct } from "@/resource/GFFStruct";

/**
 * SWVarTable: local booleans (BitArray of DWORDs) and local numbers (ByteArray
 * of BYTEs) on module objects and on the module itself.
 *
 * At least 3 DWORDs / 8 BYTEs are written (the layout this port always wrote),
 * then as many more as the highest index actually set needs: KotOR scripts use
 * number indices above 7 (k_inc_generic's SW_NUMBER_COMBO_ROUTINE is 12), so
 * a fixed 8-byte array silently lost them on every save. Bounded so a script
 * index bug cannot grow a save without limit; the retail maxima are not
 * verified, these are generous upper bounds.
 */
export const SWVAR_MIN_BOOLEANS = 96;
export const SWVAR_MIN_NUMBERS = 8;
export const SWVAR_MAX_BOOLEANS = 1024;
export const SWVAR_MAX_NUMBERS = 256;

export interface ISWVarTableLocals {
  Booleans: { [index: number]: boolean } | boolean[];
  /** ModuleObject declares this as `{}`; keyed by index either way. */
  Numbers: { [index: number]: number } | {};
}

export function isSWVarIndex(index: number, max: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < max;
}

/** Local numbers are unsigned bytes (TSL nwscript.nss: "the value range is 0 to 255"). */
export function toSWVarNumber(value: number): number {
  return (Number(value) || 0) & 0xFF;
}

function highestSetIndex(values: { [index: number]: any }, max: number): number {
  let highest = -1;
  for(const key of Object.keys(values)){
    const index = Number(key);
    if(!values[index] || !isSWVarIndex(index, max)){ continue; }
    if(index > highest){ highest = index; }
  }
  return highest;
}

export function buildSWVarTableStruct(locals: ISWVarTableLocals): GFFStruct {
  const booleans = locals.Booleans as { [index: number]: boolean };
  const numbers = locals.Numbers as { [index: number]: number };
  const struct = new GFFStruct();

  const booleanCount = Math.max(SWVAR_MIN_BOOLEANS, highestSetIndex(booleans, SWVAR_MAX_BOOLEANS) + 1);
  const bitArray = struct.addField( new GFFField(GFFDataType.LIST, 'BitArray') );
  for(let word = 0; word < Math.ceil(booleanCount / 32); word++){
    let value = 0;
    for(let bit = 0; bit < 32; bit++){
      if(booleans[(word * 32) + bit]){
        value |= 1 << bit;
      }
    }
    const varStruct = new GFFStruct();
    varStruct.addField( new GFFField(GFFDataType.DWORD, 'Variable') ).setValue( value >>> 0 );
    bitArray.addChildStruct(varStruct);
  }

  const numberCount = Math.max(SWVAR_MIN_NUMBERS, highestSetIndex(numbers, SWVAR_MAX_NUMBERS) + 1);
  const byteArray = struct.addField( new GFFField(GFFDataType.LIST, 'ByteArray') );
  for(let i = 0; i < numberCount; i++){
    const varStruct = new GFFStruct();
    varStruct.addField( new GFFField(GFFDataType.BYTE, 'Variable') ).setValue( toSWVarNumber(numbers[i]) );
    byteArray.addChildStruct(varStruct);
  }
  return struct;
}

export function readSWVarTableStruct(struct: GFFStruct | undefined, setBoolean: (index: number, value: boolean) => void, setNumber: (index: number, value: number) => void){
  if(!struct){ return; }
  if(struct.hasField('BitArray')){
    const words = struct.getFieldByLabel('BitArray').getChildStructs();
    for(let word = 0; word < Math.min(words.length, SWVAR_MAX_BOOLEANS / 32); word++){
      const data = words[word].getFieldByLabel('Variable').getValue() >>> 0;
      for(let bit = 0; bit < 32; bit++){
        setBoolean((word * 32) + bit, ((data >>> bit) & 1) == 1);
      }
    }
  }
  if(struct.hasField('ByteArray')){
    const bytes = struct.getFieldByLabel('ByteArray').getChildStructs();
    for(let i = 0; i < Math.min(bytes.length, SWVAR_MAX_NUMBERS); i++){
      setNumber(i, bytes[i].getFieldByLabel('Variable').getValue());
    }
  }
}
