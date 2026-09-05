from __future__ import annotations

import ctypes
from contextlib import closing
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from document_input import document_inputs
from engine import OcrEngine
from pdf_text import extract_pdf_page
from text_layout import group_glyphs, infer_glyph_direction, normalize_page, ruby_regions
from export_service import export_results, text_html


def create_test_pdf(path, texts):
    """Real PDF fixtures using only the shipped PDFium dependency."""
    from pypdfium2 import PdfDocument, raw
    with PdfDocument.new() as document:
        for text in texts:
            page = document.new_page(400, 500)
            if text:
                obj = raw.FPDFPageObj_NewTextObj(document, b"Helvetica", 14)
                encoded = text.encode("utf-16-le") + b"\x00\x00"
                buffer = (ctypes.c_ushort * (len(encoded)//2)).from_buffer_copy(encoded)
                if not raw.FPDFText_SetText(obj, buffer):
                    raise RuntimeError("PDF fixture text failed")
                raw.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 30, 400)
                raw.FPDFPage_InsertObject(page, obj)
                page.gen_content()
            page.close()
        document.save(path)


class PdfTextTests(unittest.TestCase):
    def test_real_text_pdf_bypasses_render_and_preserves_coordinates(self):
        from pypdfium2 import PdfPage
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"text.pdf"
            create_test_pdf(path, ["Hello world. Text layer test."])
            with patch.object(PdfPage, "render", side_effect=AssertionError("must not render")):
                with document_inputs(path, [0], pdf_source="auto") as pages:
                    page = next(pages)[1]
            self.assertIn("Hello world", page["text"])
            self.assertEqual(page["source"], "pdf-text")
            self.assertIsNone(page["blocks"][0]["score"])
            self.assertLess(page["blocks"][0]["box"][1], 150)
            path.rename(path.with_suffix(".closed.pdf"))

    def test_mixed_and_force_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"mixed.pdf"
            create_test_pdf(path,["Real text layer here",None])
            with document_inputs(path,[0,1],pdf_source="auto") as pages:
                values=list(pages)
            self.assertIsInstance(values[0][1],dict)
            self.assertEqual(values[1][1].shape,(1000,800,3))
            with document_inputs(path,[0],pdf_source="ocr") as pages:
                self.assertEqual(next(pages)[1].shape,(1000,800,3))

    def test_engine_ocr_only_for_scanned_page_and_resume(self):
        calls=[]
        pipeline=SimpleNamespace(predict_iter=lambda **kwargs: calls.append(kwargs) or iter([SimpleNamespace(json={"res":{"rec_texts":["scan"]}})]))
        engine=OcrEngine()
        engine._ocr,engine._profile,engine._mode=pipeline,"fast","text"
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"mixed.pdf"
            create_test_pdf(path,["Real text layer here",None])
            result=engine.recognize(str(path),pdf_source="auto")
            self.assertEqual(len(calls),1)
            self.assertEqual([p["source"] for p in result["pages"]],["pdf-text","ocr"])
            result=engine.recognize(str(path),pdf_source="auto",completed_pages=[0])
            self.assertEqual(result["pages"][0]["pageIndex"],1)
            self.assertEqual(result["pdfSource"],"auto")

    def test_cancel_during_ruby_does_not_checkpoint_incomplete_page(self):
        import numpy as np
        engine=OcrEngine()
        def predict(**kwargs):
            engine.cancel()
            return iter([SimpleNamespace(json={"res":{"rec_texts":["body"]}})])
        engine._ocr,engine._mode=SimpleNamespace(predict_iter=predict),"text"
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"ruby.png"
            Image.fromarray(np.full((100,100,3),255,dtype=np.uint8)).save(path)
            with patch("engine.ruby_regions",return_value=[[5,5,15,15]]):
                result=engine.recognize(str(path),ruby_enabled=True)
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["pageCount"],0)

    def test_image_with_text_header_falls_back(self):
        from pypdfium2 import PdfDocument, PdfImage
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"text.pdf"
            create_test_pdf(path,["Header with unread scanned body"])
            with PdfDocument(path) as doc:
                page=doc[0]
                image=PdfImage.new(doc)
                import io
                buffer=io.BytesIO()
                Image.new("RGB",(100,100),"white").save(buffer,format="JPEG")
                buffer.seek(0)
                image.load_jpeg(buffer)
                from pypdfium2 import PdfMatrix
                image.set_matrix(PdfMatrix(300,0,0,300,30,50))
                page.insert_obj(image)
                page.gen_content()
                self.assertIsNone(extract_pdf_page(page,0))
                page.close()

    def test_invalid_unicode_falls_back(self):
        from pypdfium2 import PdfDocument,raw
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"bad.pdf"
            create_test_pdf(path,["Some readable text"])
            with PdfDocument(path) as doc:
                with closing(doc[0]) as page, patch.object(raw,"FPDFText_GetUnicode",return_value=0xfffd):
                    self.assertIsNone(extract_pdf_page(page,0))


class RubyTests(unittest.TestCase):
    def block(self,text,box,size,direction):
        return {"text":text,"box":box,"polygon":[],"score":.95,"fontSize":size,"direction":direction}

    def test_horizontal_and_vertical_binding(self):
        for direction,body_box,ruby_box in [("horizontal",[10,30,70,50],[10,18,70,27]),("vertical",[10,10,30,70],[33,10,42,70])]:
            blocks=[self.block("薔薇色",body_box,20,direction),self.block("ばらいろ",ruby_box,9,direction)]
            page=normalize_page({"text":"薔薇色\nばらいろ","blocks":blocks,"tables":[]},100,100,"ocr",True)
            self.assertEqual(blocks[0]["ruby"][0]["text"],"ばらいろ")
            self.assertEqual(blocks[0]["ruby"][0]["end"],3)
            self.assertEqual(blocks[1]["role"],"ruby")
            self.assertIn("ばらいろ",page["rawText"])

    def test_unmatched_ruby_retained_and_overlapping_ranges_not_guessed(self):
        blocks=[self.block("本文",[10,30,50,50],20,"horizontal"),self.block("よみ",[10,18,50,27],9,"horizontal"),
                self.block("別",[10,18,30,27],9,"horizontal"),self.block("孤立",[300,300,330,309],9,"horizontal")]
        blocks[-1]["rubyCandidate"]=True
        normalize_page({"text":"raw","blocks":blocks,"tables":[]},500,500,"ocr",True)
        self.assertEqual(len(blocks[0]["ruby"]),1)
        self.assertEqual(blocks[2]["role"],"ruby-unmatched")
        self.assertEqual(blocks[3]["role"],"ruby-unmatched")

    def test_glyphs_keep_internal_spaces_and_vertical_order(self):
        glyphs=[{"text":c,"box":[10,10+i*20,28,28+i*20],"size":20} for i,c in enumerate("日本語")]
        self.assertEqual(infer_glyph_direction(glyphs),"vertical")
        self.assertEqual(group_glyphs(glyphs,"vertical")[0]["text"],"日本語")

    def test_blank_raster_has_no_ruby_and_is_not_modified(self):
        import numpy as np
        source=np.full((500,300,3),255,dtype=np.uint8)
        self.assertEqual(ruby_regions(source),[])
        self.assertTrue((source==255).all())

    def test_raster_side_small_components_are_detected(self):
        import numpy as np
        source=np.full((500,300,3),255,dtype=np.uint8)
        for x in (30,90,150,210):
            for y in range(30,440,30):
                source[y:y+20,x:x+20]=0
        for y in range(90,148,12):
            source[y:y+9,53:62]=0
        self.assertTrue(ruby_regions(source))


class TextHtmlTests(unittest.TestCase):
    def test_html_ruby_roundtrip_and_injection_is_inert(self):
        value=text_html('<ruby onclick="bad()">薔薇色<rt>ばらいろ</rt></ruby><img src="https://example.com"><script>alert(1)</script>')
        self.assertIn("<ruby>薔薇色<rt>ばらいろ</rt></ruby>",value)
        for prohibited in ("onclick", "<img", "<script", "https://example.com"):
            self.assertNotIn(prohibited,value)

    def test_text_only_html_and_txt_and_combined(self):
        with tempfile.TemporaryDirectory() as directory:
            payload={"directory":directory,"formats":["txt","html"],"textItems":[
                {"id":"one","fileName":"one.pdf","text":"薔薇色（ばらいろ）","html":"<ruby>薔薇色<rt>ばらいろ</rt></ruby>","mode":"text"}],"options":{"grouping":"combined"}}
            result=export_results(payload)
            self.assertEqual(result["count"],2)
            self.assertIn("<rt>ばらいろ</rt>",next(Path(directory).glob("*.html")).read_text(encoding="utf-8"))
            self.assertIn("（ばらいろ）",next(Path(directory).glob("*.txt")).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
