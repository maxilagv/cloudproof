from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "output" / "pdf" / "Tesis_Developer_Reliability_Platform_v0.3.pdf"
OUT_DIR = ROOT / "output" / "pdf"
TMP_DIR = ROOT / "tmp" / "pdfs"
ADDENDUM = TMP_DIR / "Tesis_Developer_Reliability_Platform_v0.4_addendum.pdf"
FINAL = OUT_DIR / "Tesis_Developer_Reliability_Platform_v0.4.pdf"


def para(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def cell(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def section(title: str, body: list[str], styles: dict[str, ParagraphStyle]) -> list:
    flow = [Spacer(1, 4 * mm), para(title, styles["h1"])]
    flow.extend(para(item, styles["body"]) for item in body)
    return flow


def bullets(items: list[str], styles: dict[str, ParagraphStyle]) -> list:
    return [para(f"<bullet>-</bullet>{item}", styles["bullet"]) for item in items]


def table(rows: list[list], widths: list[float]) -> Table:
    built = Table(rows, colWidths=widths, repeatRows=1)
    built.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return built


def doc_header_footer(canvas, doc) -> None:
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor("#D5DCE6"))
    canvas.line(18 * mm, height - 15 * mm, width - 18 * mm, height - 15 * mm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#52616F"))
    canvas.drawString(18 * mm, height - 11 * mm, "Developer Reliability Platform - Addendum estrategico v0.4")
    canvas.drawRightString(width - 18 * mm, 11 * mm, f"Pagina {doc.page}")
    canvas.restoreState()


def build_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "AddendumTitle", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=25, leading=30, textColor=colors.HexColor("#102A43"),
            alignment=TA_CENTER, spaceAfter=8 * mm,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle", parent=base["Normal"], fontName="Helvetica",
            fontSize=12, leading=17, textColor=colors.HexColor("#486581"),
            alignment=TA_CENTER, spaceAfter=6 * mm,
        ),
        "h1": ParagraphStyle(
            "H1", parent=base["Heading1"], fontName="Helvetica-Bold",
            fontSize=16, leading=20, textColor=colors.HexColor("#102A43"),
            spaceBefore=4 * mm, spaceAfter=3 * mm,
        ),
        "h2": ParagraphStyle(
            "H2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=11.5, leading=15, textColor=colors.HexColor("#243B53"),
            spaceBefore=3 * mm, spaceAfter=2 * mm,
        ),
        "body": ParagraphStyle(
            "Body", parent=base["BodyText"], fontName="Helvetica",
            fontSize=9.4, leading=13.5, textColor=colors.HexColor("#243B53"),
            spaceAfter=2.4 * mm,
        ),
        "bullet": ParagraphStyle(
            "Bullet", parent=base["BodyText"], fontName="Helvetica",
            fontSize=9.2, leading=13, leftIndent=5 * mm, firstLineIndent=-3 * mm,
            textColor=colors.HexColor("#243B53"), spaceAfter=1.4 * mm,
        ),
        "small": ParagraphStyle(
            "Small", parent=base["BodyText"], fontName="Helvetica",
            fontSize=7.8, leading=10.5, textColor=colors.HexColor("#52616F"),
            spaceAfter=1.3 * mm,
        ),
        "table": ParagraphStyle(
            "Table", parent=base["BodyText"], fontName="Helvetica",
            fontSize=7.9, leading=10.1, textColor=colors.HexColor("#243B53"),
        ),
        "tablehead": ParagraphStyle(
            "TableHead", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=7.9, leading=10.1, textColor=colors.white,
        ),
        "callout": ParagraphStyle(
            "Callout", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=10.5, leading=15, textColor=colors.HexColor("#102A43"),
            borderColor=colors.HexColor("#2F80ED"), borderWidth=0.8,
            borderPadding=3.5 * mm, backColor=colors.HexColor("#EEF6FF"),
            spaceAfter=4 * mm,
        ),
        "warn": ParagraphStyle(
            "Warn", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=10, leading=14.5, textColor=colors.HexColor("#7A2E0E"),
            borderColor=colors.HexColor("#E8833A"), borderWidth=0.8,
            borderPadding=3.5 * mm, backColor=colors.HexColor("#FEF6EE"),
            spaceAfter=4 * mm,
        ),
        "mono": ParagraphStyle(
            "Mono", parent=base["Code"], fontName="Courier",
            fontSize=7.7, leading=10.2, textColor=colors.HexColor("#102A43"),
        ),
    }


def build_addendum() -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    styles = build_styles()

    document = SimpleDocTemplate(
        str(ADDENDUM), pagesize=A4,
        rightMargin=18 * mm, leftMargin=18 * mm,
        topMargin=21 * mm, bottomMargin=18 * mm,
        title="Tesis de Producto - Developer Reliability Platform v0.4",
        author="Proof",
    )

    story: list = []

    # ---------------------------------------------------------------- portada
    story.extend([
        Spacer(1, 34 * mm),
        para("ADDENDUM ESTRATEGICO v0.4", styles["title"]),
        para("El regimen de confiabilidad: de un 3% de falso positivo a un contrato de soundness", styles["subtitle"]),
        para("Correccion de la meta de calidad de la seccion 16.3 - 20 de julio de 2026", styles["subtitle"]),
        Spacer(1, 8 * mm),
        para(
            "<b>Decision de tesis:</b> la meta de calidad de la v0.2 era demasiado baja y estaba mal formulada. "
            "Un solo numero agregado ('falso positivo bloqueante &lt; 3%') mezcla cuatro propiedades que fallan por "
            "causas distintas y cuestan distinto. Esta revision las separa, sube la exigencia donde el determinismo "
            "la hace alcanzable, y la declara acotada donde prometerla seria deshonesto.",
            styles["callout"],
        ),
        para(
            "Este addendum conserva la tesis v0.2 y el addendum v0.3 como documentos base. No agrega superficies de "
            "producto ni declara capacidades nuevas. Reemplaza una tabla de metricas objetivo y las reglas de gate "
            "asociadas, a partir de una auditoria adversarial del motor realizada el 20 de julio de 2026.",
            styles["body"],
        ),
        Spacer(1, 6 * mm),
        para("Estado de esta revision", styles["h2"]),
        para(
            "Alcance: regimen de confiabilidad, definicion de metricas, gates de Enforce y presupuesto de decision "
            "para agentes. Sustituye la seccion 16.3 de la v0.2. No modifica el roadmap de fases ni el alcance del MVP.",
            styles["body"],
        ),
        PageBreak(),
    ])

    # ------------------------------------------------------- 1. el techo malo
    story += section(
        "1. Por que la meta de la v0.2 era el techo equivocado",
        [
            "La seccion 16.3 fijo como objetivo de diseno 'falso positivo bloqueante &lt; 3%' y 'findings reproducibles "
            "&gt; 95%'. Comparado con el estado del arte de herramientas que dependen de heuristicas o de un modelo "
            "probabilistico, es una meta razonable. Comparado con lo que Proof afirma ser, es un techo que contradice "
            "el propio posicionamiento del documento.",
            "El problema no es solo la magnitud. Un 3% de falso positivo bloqueante significa que uno de cada treinta "
            "y tres bloqueos es ruido. Ningun equipo deja un gate en modo Enforce con esa tasa: lo pasa a Observe, "
            "y un gate en Observe no previene incidentes, solo los documenta despues. La meta de la v0.2, cumplida al "
            "pie de la letra, produce un producto que nadie deja encendido.",
            "El problema mas profundo es la formulacion. 'Falso positivo' agrega en un solo numero cuatro fallas "
            "distintas: declarar seguro algo que rompe, declarar roto algo que funciona, dar veredictos distintos "
            "para la misma entrada, y no ver una clase de fallo que esta fuera de la cobertura. Tienen causas "
            "distintas, se arreglan distinto y cuestan ordenes de magnitud distintos. Un objetivo agregado no puede "
            "guiar ninguna decision de ingenieria concreta.",
        ],
        styles,
    )

    # ------------------------------------------------------- 2. la asimetria
    story += section(
        "2. La asimetria fundamental: los errores no cuestan igual",
        [
            "Proof puede equivocarse en dos direcciones y la tesis las trato hasta ahora como simetricas. No lo son, "
            "y esa asimetria debe quedar escrita en el regimen de calidad porque determina cada decision de diseno "
            "posterior.",
        ],
        styles,
    )
    story += [Spacer(1, 1 * mm), table([
        [cell("Error", styles["tablehead"]), cell("Que ocurre", styles["tablehead"]),
         cell("Costo", styles["tablehead"]), cell("Recuperabilidad", styles["tablehead"])],
        [cell("<b>Falso VERIFIED</b>", styles["table"]),
         cell("Proof declara segura una transicion que rompe en produccion.", styles["table"]),
         cell("Un incidente. Downtime, perdida de datos o corrupcion silenciosa. El costo no lo paga Proof: lo paga el usuario, y lo descubre tarde.", styles["table"]),
         cell("<b>Nula.</b> El dano ya ocurrio y la confianza en toda evidencia previa queda invalidada retroactivamente.", styles["table"])],
        [cell("<b>Falso UNSAFE</b>", styles["table"]),
         cell("Proof bloquea un release que en realidad era seguro.", styles["table"]),
         cell("Minutos de investigacion y un override. Friccion, no dano.", styles["table"]),
         cell("Total. El usuario inspecciona la evidencia, ve que no aplica y sigue.", styles["table"])],
        [cell("<b>INCONCLUSIVE</b>", styles["table"]),
         cell("Proof no puede concluir y lo declara.", styles["table"]),
         cell("El costo de la corrida. No es un error: es el comportamiento correcto ante evidencia insuficiente.", styles["table"]),
         cell("Total, y ademas informativa: dice que falta para concluir.", styles["table"])],
    ], [26 * mm, 44 * mm, 52 * mm, 52 * mm])]

    story += [Spacer(1, 3 * mm), para(
        "<b>Regla derivada.</b> Un falso VERIFIED y un falso UNSAFE nunca se compensan entre si en una metrica "
        "agregada. Ante cualquier duda de diseno, Proof degrada a INCONCLUSIVE. Toda optimizacion que reduzca ruido "
        "a costa de aumentar aunque sea marginalmente la probabilidad de un falso VERIFIED queda prohibida, sin "
        "importar cuanto mejore la experiencia percibida.",
        styles["warn"],
    )]

    # -------------------------------------------- 3. descomposicion del 99.99
    story += section(
        "3. Descomposicion: cinco propiedades, cinco metas distintas",
        [
            "La ambicion correcta no es 'Proof acierta el 99.99% de las veces'. Esa frase no es medible porque no "
            "declara el denominador. La ambicion correcta es un regimen con cinco propiedades independientes, cada "
            "una con su meta, su metodo de medicion y su condicion de falla.",
        ],
        styles,
    )
    story += [Spacer(1, 1 * mm), table([
        [cell("Propiedad", styles["tablehead"]), cell("Definicion", styles["tablehead"]),
         cell("Meta v0.4", styles["tablehead"]), cell("Como se mide", styles["tablehead"])],
        [cell("<b>P1. Soundness</b>", styles["table"]),
         cell("Si Proof emite VERIFIED, la transicion es operativa dentro del alcance declarado. Es una propiedad de <i>seguridad</i>: no admite excepciones estadisticas.", styles["table"]),
         cell("<b>Cero caminos conocidos no mitigados.</b> No es un porcentaje: es una lista que debe estar vacia.", styles["table"]),
         cell("Auditoria adversarial periodica + corpus de casos disenados para producir un falso VERIFIED. Cada camino hallado se cierra o se documenta como limite de alcance.", styles["table"])],
        [cell("<b>P2. Determinismo</b>", styles["table"]),
         cell("La misma entrada (par de SHAs, config, workload) produce el mismo veredicto.", styles["table"]),
         cell("<b>99.99%</b> de concordancia sobre corridas repetidas.", styles["table"]),
         cell("N corridas del mismo par de SHAs en el mismo runner y en runners de distinta carga. Toda discordancia es un defecto del arnes, no del release.", styles["table"])],
        [cell("<b>P3. Precision</b>", styles["table"]),
         cell("Si Proof emite UNSAFE, existe una causa real y reproducible.", styles["table"]),
         cell("<b>&gt; 99.5%</b> (falso UNSAFE &lt; 0.5%).", styles["table"]),
         cell("Revision humana de cada UNSAFE en pilotos, con reproduccion obligatoria del hallazgo.", styles["table"])],
        [cell("<b>P4. Cobertura</b>", styles["table"]),
         cell("Que fraccion de la superficie de riesgo real fue efectivamente ejercitada.", styles["table"]),
         cell("<b>Declarada, no maximizada.</b> Sin meta numerica global.", styles["table"]),
         cell("Reportada por corrida como dato duro (rutas, escrituras, estados, omisiones). Nunca se colapsa en el veredicto.", styles["table"])],
        [cell("<b>P5. Costo de decision</b>", styles["table"]),
         cell("Recursos que un consumidor -agente o humano- gasta para llegar a una decision fundada.", styles["table"]),
         cell("Ver seccion 7. Presupuesto explicito en tokens y en tiempo.", styles["table"]),
         cell("Tokens del resultado de cada tool y latencia p95 por nivel de la escalera L0-L3.", styles["table"])],
    ], [26 * mm, 50 * mm, 40 * mm, 58 * mm])]

    story += [Spacer(1, 3 * mm), para(
        "<b>El movimiento clave de esta revision.</b> P1 sube de 'menos del 3% de error agregado' a una propiedad "
        "absoluta sin tolerancia estadistica. P2 sube a 99.99%. P3 sube de 97% a 99.5%. Y P4 <b>deja de tener meta "
        "numerica</b>: prometer un porcentaje de cobertura de la superficie de riesgo real seria exactamente la clase "
        "de afirmacion no demostrable que el addendum v0.3 prohibio en su seccion 1. La cobertura se declara, se "
        "publica y se hace visible; no se promete.",
        styles["callout"],
    )]

    story += [para(
        "Separar P1 de P4 es lo que permite ser mucho mas ambicioso sin volverse deshonesto. Proof puede afirmar con "
        "rigor que <i>nunca declara seguro lo que su propio alcance demostro roto</i> (P1, absoluta) sin afirmar "
        "jamas que <i>ve todo lo que puede romperse</i> (P4, acotada y explicita). La v0.2 mezclaba ambas en un solo "
        "numero y por eso no podia ser exigente en ninguna.",
        styles["body"],
    )]

    story += [PageBreak()]

    # ------------------------------------- 4. por que aca si es alcanzable
    story += section(
        "4. Por que 99.99% es alcanzable en Proof y no en un evaluador probabilistico",
        [
            "La meta del 3% era razonable para una categoria de herramienta que Proof deliberadamente no es. Un "
            "analizador heuristico o un evaluador basado en un modelo de lenguaje tiene un piso de error irreducible: "
            "su salida es una estimacion, y dos ejecuciones con la misma entrada pueden diferir por construccion. "
            "Para esa categoria, 3% es una meta honesta y 99.99% seria una fantasia.",
            "Proof pertenece a otra categoria y esa diferencia es precisamente su moat. La decision D-005 y la D-015 "
            "establecieron que ningun comando nucleo depende de una llamada a un modelo para producir su resultado. "
            "El veredicto se deriva de assertions tipadas sobre hechos observados en una ejecucion real. Un sistema "
            "asi no tiene un piso de error probabilistico: tiene defectos, que son finitos, enumerables y cerrables.",
            "Esa distincion convierte el objetivo en un problema de ingenieria y no de estadistica. No se trata de "
            "empujar una distribucion hacia la derecha, sino de vaciar una lista. La auditoria de la seccion 5 "
            "demuestra que la lista es corta y concreta, no un horizonte abierto.",
        ],
        styles,
    )
    story += [Spacer(1, 1 * mm), table([
        [cell("Propiedad ya verificada en el motor", styles["tablehead"]), cell("Consecuencia para el regimen", styles["tablehead"])],
        [cell("El replay HTTP no reintenta: un fallo se convierte en mismatch y se compara fail-closed.", styles["table"]),
         cell("Un bug intermitente de la aplicacion bajo prueba no puede ser reintentado hasta pasar. Cierra la via mas comun de falso VERIFIED en herramientas de replay.", styles["table"])],
        [cell("Los reintentos existentes estan acotados a sondas de infraestructura de solo lectura y filtrados por un clasificador de error transitorio que deliberadamente no matchea errores SQL reales.", styles["table"]),
         cell("La distincion entre 'fallo del arnes' y 'fallo del release' esta implementada, no solo documentada. Es el prerequisito de P2.", styles["table"])],
        [cell("La conclusion se deriva de assertions tipadas con gates explicitos de coverage, workload y metodo de escritura observado.", styles["table"]),
         cell("No existe un camino a VERIFIED con cobertura vacia. La defensa esta en el camino de ejecucion real, no solo en el schema.", styles["table"])],
        [cell("El veredicto INCONCLUSIVE es de primera clase y ninguna politica lo convierte en VERIFIED.", styles["table"]),
         cell("La degradacion segura ya es el comportamiento por defecto ante evidencia faltante.", styles["table"])],
    ], [82 * mm, 92 * mm])]

    # --------------------------------------------- 5. la auditoria como base
    story += section(
        "5. Evidencia: la auditoria adversarial del 20 de julio de 2026",
        [
            "El regimen de esta revision no es aspiracional. Se apoya en una auditoria adversarial del motor "
            "realizada con revision independiente y verificacion cruzada de cada hallazgo contra el codigo fuente. "
            "El resultado relevante para la tesis es que, dentro del stack que Proof declara soportar, se "
            "identificaron <b>exactamente dos caminos confirmados a un falso VERIFIED</b>. No una familia abierta de "
            "problemas: dos defectos concretos con fix acotado.",
        ],
        styles,
    )
    story += [Spacer(1, 1 * mm), table([
        [cell("Camino a falso VERIFIED", styles["tablehead"]), cell("Mecanismo", styles["tablehead"]), cell("Estado", styles["tablehead"])],
        [cell("<b>V-1.</b> Normalizacion de identificadores numericos sin restriccion de forma.", styles["table"]),
         cell("El normalizador de respuestas reemplaza por un placeholder cualquier valor numerico bajo una clave que matchea el patron de identificador, sin exigirle forma opaca -restriccion que si aplica a los strings. Dos respuestas que difieren en una referencia relacional de negocio se comparan como iguales. Los efectos SQL no lo cubren: una lectura incorrecta no altera los contadores de escritura.", styles["table"]),
         cell("Confirmado. Fix acotado: exigir forma tambien a los valores numericos y preservar cardinalidad en el placeholder.", styles["table"])],
        [cell("<b>V-2.</b> La evidencia estatica no se consume en la verificacion dinamica.", styles["table"]),
         cell("El clasificador estatico detecta DDL destructivo y lo marca como riesgo critico, pero el comando de verificacion no lo invoca ni consume su resultado. Una operacion destructiva sobre una superficie que el workload no ejercita no produce ninguna assertion fallida y el veredicto puede ser VERIFIED.", styles["table"]),
         cell("Confirmado. El detector ya existe y esta probado; falta conectarlo al camino de decision.", styles["table"])],
    ], [40 * mm, 100 * mm, 34 * mm])]

    story += [Spacer(1, 2 * mm), para(
        "La auditoria tambien corrigio tres afirmaciones que, de haber pasado al documento sin verificar, habrian "
        "danado su credibilidad: el clasificador estatico esta correctamente disenado respecto de los defaults "
        "constantes en PostgreSQL 11 o superior, la huella de esquema si captura tipos con precision y expresiones "
        "de default, y el costo en tokens del resultado tiene una distribucion bimodal y no un promedio plano. "
        "Se registran aca porque la disciplina de verificar antes de afirmar es parte del regimen, no un tramite.",
        styles["body"],
    )]

    story += [para(
        "<b>Hueco de alcance identificado y asumido.</b> No existe verificacion de perdida de datos: el motor no "
        "cuenta filas ni compara contenido entre el esquema base y el migrado. Proof puede declarar operativa una "
        "transicion sin haber contado jamas una fila. No es un camino a falso VERIFIED dentro del alcance declarado "
        "-porque el alcance nunca prometio integridad de datos- pero es la brecha conceptual mas grande del motor y "
        "queda incorporada como P1 del plan de la seccion 6.",
        styles["warn"],
    )]

    story += [PageBreak()]

    # ------------------------------------------------------ 6. nuevos gates
    story += section(
        "6. Gates que reemplazan la seccion 16.3",
        [
            "Esta tabla sustituye integramente las metricas objetivo iniciales de la v0.2. Los gates no son "
            "aspiraciones: ninguna transicion de fase se autoriza sin cerrarlos, del mismo modo que la Fase 1.X del "
            "addendum v0.3 condiciona la Fase 2.",
        ],
        styles,
    )
    story += [Spacer(1, 1 * mm), table([
        [cell("Gate", styles["tablehead"]), cell("Criterio v0.2 (derogado)", styles["tablehead"]),
         cell("Criterio v0.4", styles["tablehead"]), cell("Bloquea", styles["tablehead"])],
        [cell("<b>G1. Soundness</b>", styles["table"]),
         cell("Incluido en 'falso positivo &lt; 3%'.", styles["table"]),
         cell("Lista de caminos conocidos a falso VERIFIED vacia. Corpus adversarial de al menos 30 casos disenados para enganar al motor, todos resueltos en UNSAFE o INCONCLUSIVE, ninguno en VERIFIED.", styles["table"]),
         cell("Cualquier modo Enforce, en cualquier fase.", styles["table"])],
        [cell("<b>G2. Determinismo</b>", styles["table"]),
         cell("'Findings reproducibles &gt; 95%'.", styles["table"]),
         cell("50 corridas del mismo par de SHAs producen el mismo veredicto, incluyendo al menos 10 bajo contencion de recursos inducida. Toda discordancia se trata como defecto bloqueante del arnes.", styles["table"]),
         cell("Fase 2 (integracion CI).", styles["table"])],
        [cell("<b>G3. Precision</b>", styles["table"]),
         cell("Falso positivo bloqueante &lt; 3%.", styles["table"]),
         cell("Falso UNSAFE &lt; 0.5% con revision humana de cada caso y reproduccion obligatoria del hallazgo.", styles["table"]),
         cell("Modo Enforce en pilotos.", styles["table"])],
        [cell("<b>G4. Honestidad de alcance</b>", styles["table"]),
         cell("No existia.", styles["table"]),
         cell("Todo veredicto VERIFIED publica el alcance que lo sostiene: volumen de datos usado, rutas ejercitadas sobre rutas conocidas, canales no observados y evidencia estatica consumida. Un VERIFIED sin alcance publicado es un defecto.", styles["table"]),
         cell("Lanzamiento open source.", styles["table"])],
        [cell("<b>G5. Costo de decision</b>", styles["table"]),
         cell("No existia.", styles["table"]),
         cell("Ver seccion 7: presupuesto de tokens y latencia por nivel, cumplido en un benchmark con al menos dos harnesses de agente distintos.", styles["table"]),
         cell("Mensaje comercial de compatibilidad con agentes.", styles["table"])],
    ], [26 * mm, 34 * mm, 82 * mm, 32 * mm])]

    # ----------------------------------------- 7. presupuesto de decision
    story += section(
        "7. El presupuesto de decision: los tokens son una metrica de confiabilidad",
        [
            "La v0.2 trato la salida legible por maquina como un requisito de formato y la v0.3 pidio resultados "
            "'estructurados y compactos'. Ninguna fijo un presupuesto. Esta revision lo convierte en metrica de "
            "primera clase, por una razon que no es de comodidad sino de confiabilidad: cuando el resultado de una "
            "verificacion no entra comodamente en el contexto de quien debe decidir, ese consumidor decide con una "
            "fraccion de la evidencia, y una decision tomada sobre evidencia truncada es indistinguible de una "
            "decision tomada sin evidencia.",
            "La medicion de la auditoria mostro que el costo del resultado tiene distribucion bimodal: una corrida "
            "sana ronda el orden de los miles de tokens, mientras que una corrida con fallos generalizados puede "
            "multiplicarlo por seis o mas, porque cada assertion fallida arrastra el contexto de reproduccion "
            "completo. El costo explota exactamente en el momento en que el consumidor mas necesita leer con "
            "cuidado. Ese es el defecto a corregir, no el promedio.",
        ],
        styles,
    )
    story += [Spacer(1, 1 * mm), table([
        [cell("Superficie", styles["tablehead"]), cell("Presupuesto", styles["tablehead"]), cell("Regla", styles["tablehead"])],
        [cell("Resultado por defecto de cualquier tool de verificacion", styles["table"]),
         cell("<b>&lt;= 1.500 tokens</b>", styles["table"]),
         cell("Veredicto, acciones tipadas siguientes, resumen de cobertura y referencia al artefacto completo. Suficiente para decidir; insuficiente para auditar.", styles["table"])],
        [cell("Evidencia completa", styles["table"]),
         cell("Sin limite", styles["table"]),
         cell("Se obtiene bajo demanda explicita, nunca por defecto. El consumidor decide cuando pagar ese costo.", styles["table"])],
        [cell("Elemento individual de evidencia", styles["table"]),
         cell("<b>Acotado por schema</b>", styles["table"]),
         cell("El formato debe imponer la cota, no confiar en que el productor se comporte. Un limite declarado en prosa y no aplicado en el schema es un limite inexistente.", styles["table"])],
        [cell("Decision de escalamiento", styles["table"]),
         cell("<b>L0 &lt; 30 s / L1 &lt; 2 min</b>", styles["table"]),
         cell("El consumidor debe poder saber si vale la pena pagar el nivel caro sin haberlo pagado. Toda superficie debe declarar costo y duracion estimada antes de ejecutarse.", styles["table"])],
    ], [44 * mm, 30 * mm, 100 * mm])]

    story += [Spacer(1, 2 * mm), para(
        "<b>Principio.</b> Un verificador que obliga a su consumidor a gastar su capacidad de atencion en leerlo "
        "compite contra la tarea que deberia estar habilitando. La meta no es que Proof sea invocado muchas veces: "
        "es que cada invocacion acerque a una decision correcta con el menor gasto posible de la capacidad limitada "
        "de quien decide -sea contexto de un modelo o atencion de una persona.",
        styles["callout"],
    )]

    story += [PageBreak()]

    # ---------------------------------------- 8. contrato con el consumidor
    story += section(
        "8. Consecuencias sobre el contrato con agentes y CI",
        [
            "El regimen de esta revision modifica tres puntos del contrato operacional descrito en la seccion 9 del "
            "addendum v0.3.",
        ],
        styles,
    )
    story += bullets([
        "<b>Autodescripcion del veredicto.</b> Todo valor de conclusion que no autorice a avanzar debe ser "
        "interpretable sin contexto adicional. Un consumidor cuya ventana de contexto fue compactada no puede "
        "depender de haber leido antes la documentacion del contrato. La solucion no es renombrar el enum -eso "
        "rompe todo artefacto ya emitido- sino garantizar que la advertencia viaje junto al valor en toda superficie "
        "de presentacion, tal como ya se hace con la decision del nivel de planificacion.",
        "<b>Paridad entre superficies.</b> Toda superficie de consumo debe entregar la misma semantica. Si la "
        "interfaz de linea de comandos expone violaciones de politica y la ubicacion del artefacto, la interfaz para "
        "agentes tambien debe hacerlo. Una superficie que entrega menos informacion que otra convierte la eleccion "
        "de transporte en una decision de seguridad implicita, que es exactamente lo que el principio de "
        "interoperabilidad de la v0.3 buscaba evitar.",
        "<b>Coherencia entre lo documentado y lo emitido.</b> Las instrucciones que Proof genera para agentes no "
        "pueden exigir garantias que el propio motor no produce. Toda instruccion generada debe describir el estado "
        "real del artefacto emitido y declarar explicitamente que garantias todavia no estan disponibles.",
    ], styles)

    # ------------------------------------------------ 9. lo que no se promete
    story += section(
        "9. Lo que este regimen explicitamente no promete",
        [
            "Subir la exigencia obliga a delimitar con mas rigor, no con menos. Un regimen ambicioso sin fronteras "
            "declaradas es una promesa implicita de omnisciencia, y es la forma mas rapida de perder la credibilidad "
            "que la ambicion pretende construir.",
        ],
        styles,
    )
    story += bullets([
        "<b>No promete cobertura de la superficie de riesgo.</b> P4 no tiene meta numerica. Proof demuestra "
        "propiedades sobre lo que fue ejercitado y publica lo que no lo fue.",
        "<b>No promete deteccion de perdida o corrupcion de datos</b> hasta que exista verificacion de integridad. "
        "Hasta entonces es un limite declarado, no una capacidad implicita.",
        "<b>No promete equivalencia de comportamiento bajo carga, concurrencia o volumen de produccion.</b> La "
        "matriz se ejecuta sobre volumen de prueba y de forma secuencial.",
        "<b>No promete cubrir canales fuera de la superficie observada.</b> Trabajos en segundo plano, colas, "
        "tareas programadas y escrituras que no pasan por la superficie instrumentada quedan fuera.",
        "<b>No promete la misma garantia frente a codigo hostil que frente a un repositorio confiable.</b> La "
        "distincion de perfiles de confianza del addendum v0.3 sigue vigente y sin cerrar.",
        "<b>No promete invariantes de negocio.</b> Se mantiene sin cambios respecto de la v0.2.",
    ], styles)

    story += [Spacer(1, 2 * mm), para(
        "Cada uno de estos limites es una linea de expansion futura del regimen, no una renuncia permanente. La "
        "diferencia entre ambas cosas es que un limite declarado puede cerrarse con un gate; una omision no "
        "declarada solo se descubre en un incidente.",
        styles["body"],
    )]

    # ------------------------------------------------------ 10. decisiones
    story += section(
        "10. Decisiones y backlog que esta revision agrega",
        [],
        styles,
    )
    story += [Spacer(1, 1 * mm), table([
        [cell("ID", styles["tablehead"]), cell("Decision", styles["tablehead"]),
         cell("Estado", styles["tablehead"]), cell("Revision", styles["tablehead"])],
        [cell("D-023", styles["table"]),
         cell("La meta de calidad se descompone en cinco propiedades independientes. Queda derogada la metrica agregada de falso positivo de la seccion 16.3.", styles["table"]),
         cell("Aceptada", styles["table"]), cell("Al cerrar G1 y G2", styles["table"])],
        [cell("D-024", styles["table"]),
         cell("Soundness es una propiedad de seguridad sin tolerancia estadistica: se mide como lista vacia de caminos conocidos, no como porcentaje.", styles["table"]),
         cell("Aceptada", styles["table"]), cell("Cada auditoria", styles["table"])],
        [cell("D-025", styles["table"]),
         cell("Prohibida toda optimizacion que reduzca ruido a costa de aumentar la probabilidad de un falso VERIFIED. Ante duda de diseno, degradar a INCONCLUSIVE.", styles["table"]),
         cell("Aceptada", styles["table"]), cell("Permanente", styles["table"])],
        [cell("D-026", styles["table"]),
         cell("El costo de decision -tokens y latencia- es una metrica de confiabilidad de primera clase con presupuesto explicito, no un asunto de formato.", styles["table"]),
         cell("Aceptada", styles["table"]), cell("Al cerrar G5", styles["table"])],
        [cell("D-027", styles["table"]),
         cell("La cobertura se declara y se publica; no se promete como porcentaje. Todo VERIFIED viaja con su alcance.", styles["table"]),
         cell("Aceptada", styles["table"]), cell("Al cerrar G4", styles["table"])],
        [cell("D-028", styles["table"]),
         cell("Auditoria adversarial periodica del motor con verificacion independiente de cada hallazgo, como requisito permanente y no como evento unico.", styles["table"]),
         cell("Propuesta", styles["table"]), cell("Antes de Fase 2", styles["table"])],
    ], [16 * mm, 96 * mm, 24 * mm, 38 * mm])]

    story += [Spacer(1, 3 * mm), para("Backlog nuevo", styles["h2"])]
    story += bullets([
        "<b>I-020 - Corpus adversarial de soundness</b> - COMMITTED - al menos 30 escenarios disenados para producir "
        "un falso VERIFIED, versionados y ejecutados en cada cambio del motor.",
        "<b>I-021 - Banco de determinismo</b> - COMMITTED - ejecucion repetida del mismo par de SHAs bajo contencion "
        "inducida, con deteccion automatica de discordancia de veredicto.",
        "<b>I-022 - Verificacion de integridad de datos</b> - DESIGN - conteo y comparacion de contenido entre "
        "esquema base y migrado, con manejo explicito del no determinismo legitimo.",
        "<b>I-023 - Presupuesto de decision aplicado por schema</b> - DESIGN - cotas de tamano impuestas por el "
        "formato y resumen por defecto en toda superficie de consumo.",
        "<b>I-024 - Instrumentacion de bloqueo de migracion</b> - RESEARCH - medicion de duracion y clase de lock "
        "durante la migracion, como dato duro del artefacto.",
    ], styles)

    # ------------------------------------------------------------ 11. cierre
    story += section(
        "11. Nota metodologica",
        [
            "La auditoria adversarial citada en la seccion 5 fue realizada el 20 de julio de 2026 sobre el motor "
            "local, con revision independiente y verificacion cruzada de cada hallazgo contra el codigo fuente. "
            "Los hallazgos que no sobrevivieron la verificacion fueron descartados y quedan registrados como tales. "
            "Las metas de esta revision son objetivos de diseno con gate asociado: ninguna es una medicion ya "
            "obtenida, y ninguna debe usarse como afirmacion comercial antes de cerrar su gate correspondiente.",
            "Se conservan sin cambios las fuentes [S1] a [S23] de las revisiones anteriores. Esta revision no "
            "incorpora fuentes externas nuevas: su base de evidencia es la auditoria del propio motor.",
        ],
        styles,
    )

    story += [Spacer(1, 3 * mm), para("Cierre v0.4", styles["h2"])]
    story += [para(
        "La v0.2 se pregunto si era posible construir un verificador de transiciones stateful. La v0.3 se pregunto "
        "que tenia que ser cierto para que ese verificador mereciera confianza. Esta revision se pregunta algo mas "
        "exigente: cuanto error es aceptable en una herramienta cuya unica razon de existir es que otros dejen de "
        "adivinar. La respuesta honesta es que en la propiedad que define la categoria -no declarar seguro lo que no "
        "lo es- el error aceptable no es un porcentaje bajo, es ninguno conocido. Un verificador que se permite un "
        "3% de fallo en su afirmacion central le esta pidiendo a su usuario exactamente la fe que promete eliminar.",
        styles["body"],
    )]
    story += [para(
        "Esa exigencia no es alcanzable para una herramienta que estima. Es alcanzable para una que ejecuta, observa "
        "y deriva. Que Proof pueda aspirar a ella no es una ambicion desmedida: es la consecuencia directa de la "
        "decision de no poner un modelo probabilistico en el camino de la decision. La meta del 3% no era prudente. "
        "Era la meta de otro producto.",
        styles["body"],
    )]

    document.build(story, onFirstPage=doc_header_footer, onLaterPages=doc_header_footer)


def merge_with_thesis() -> None:
    writer = PdfWriter()
    for source in (SOURCE, ADDENDUM):
        reader = PdfReader(str(source))
        for page in reader.pages:
            writer.add_page(page)
    writer.add_metadata({
        "/Title": "Tesis de Producto - Developer Reliability Platform v0.4",
        "/Author": "Proof",
        "/Subject": "Addendum estrategico: el regimen de confiabilidad",
        "/Keywords": "release safety, evidence, soundness, determinism, agents, reliability",
    })
    with FINAL.open("wb") as output:
        writer.write(output)


if __name__ == "__main__":
    if not SOURCE.exists():
        raise SystemExit(f"No existe la tesis fuente: {SOURCE}")
    build_addendum()
    merge_with_thesis()
    print(FINAL)
