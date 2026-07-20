from __future__ import annotations

from pathlib import Path
from datetime import date

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"C:\Users\User\Downloads\Tesis_Developer_Reliability_Platform_v0.2.pdf")
OUT_DIR = ROOT / "output" / "pdf"
TMP_DIR = ROOT / "tmp" / "pdfs"
ADDENDUM = TMP_DIR / "Tesis_Developer_Reliability_Platform_v0.3_addendum.pdf"
FINAL = OUT_DIR / "Tesis_Developer_Reliability_Platform_v0.3.pdf"


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


def doc_header_footer(canvas, doc) -> None:
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor("#D5DCE6"))
    canvas.line(18 * mm, height - 15 * mm, width - 18 * mm, height - 15 * mm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#52616F"))
    canvas.drawString(18 * mm, height - 11 * mm, "Developer Reliability Platform - Addendum estrategico v0.3")
    canvas.drawRightString(width - 18 * mm, 11 * mm, f"Pagina {doc.page}")
    canvas.restoreState()


def build_addendum() -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    base = getSampleStyleSheet()
    styles = {
        "title": ParagraphStyle(
            "AddendumTitle",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=25,
            leading=30,
            textColor=colors.HexColor("#102A43"),
            alignment=TA_CENTER,
            spaceAfter=8 * mm,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=12,
            leading=17,
            textColor=colors.HexColor("#486581"),
            alignment=TA_CENTER,
            spaceAfter=6 * mm,
        ),
        "h1": ParagraphStyle(
            "H1",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=16,
            leading=20,
            textColor=colors.HexColor("#102A43"),
            spaceBefore=4 * mm,
            spaceAfter=3 * mm,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=11.5,
            leading=15,
            textColor=colors.HexColor("#243B53"),
            spaceBefore=3 * mm,
            spaceAfter=2 * mm,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.4,
            leading=13.5,
            textColor=colors.HexColor("#243B53"),
            spaceAfter=2.4 * mm,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.2,
            leading=13,
            leftIndent=5 * mm,
            firstLineIndent=-3 * mm,
            textColor=colors.HexColor("#243B53"),
            spaceAfter=1.4 * mm,
        ),
        "small": ParagraphStyle(
            "Small",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=7.8,
            leading=10.5,
            textColor=colors.HexColor("#52616F"),
            spaceAfter=1.3 * mm,
        ),
        "table": ParagraphStyle(
            "Table",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=7.9,
            leading=10.1,
            textColor=colors.HexColor("#243B53"),
        ),
        "tablehead": ParagraphStyle(
            "TableHead",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=7.9,
            leading=10.1,
            textColor=colors.white,
        ),
        "callout": ParagraphStyle(
            "Callout",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=10.5,
            leading=15,
            textColor=colors.HexColor("#102A43"),
            borderColor=colors.HexColor("#2F80ED"),
            borderWidth=0.8,
            borderPadding=3.5 * mm,
            backColor=colors.HexColor("#EEF6FF"),
            spaceAfter=4 * mm,
        ),
        "mono": ParagraphStyle(
            "Mono",
            parent=base["Code"],
            fontName="Courier",
            fontSize=7.7,
            leading=10.2,
            textColor=colors.HexColor("#102A43"),
        ),
    }

    document = SimpleDocTemplate(
        str(ADDENDUM),
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=21 * mm,
        bottomMargin=18 * mm,
        title="Tesis de Producto - Developer Reliability Platform v0.3",
        author="Proof",
    )

    story: list = []
    story.extend(
        [
            Spacer(1, 38 * mm),
            para("ADDENDUM ESTRATEGICO v0.3", styles["title"]),
            para("Proof beyond agents: una capa de evidencia para humanos, CI y cualquier harness", styles["subtitle"]),
            para("Plan de fortalecimiento previo a Fase 2 - 15 de julio de 2026", styles["subtitle"]),
            Spacer(1, 10 * mm),
            para(
                "<b>Decision de tesis:</b> no convertir Proof en otro agente. Convertirlo en el verificador independiente que un agente, un humano y un sistema de CI necesitan para declarar un cambio confiable.",
                styles["callout"],
            ),
            para(
                "Este addendum conserva la tesis v0.2 como documento base. Actualiza su estrategia a partir de la evidencia ejecutada de Fase 1, una revision del comportamiento de agentes de codigo, la documentacion de Codex Security y fuentes primarias de Atlas, Signadot, Speedscale, MCP, Claude y GitHub. Es un plan: no cambia el motor ni declara capacidades aun no implementadas.",
                styles["body"],
            ),
            Spacer(1, 8 * mm),
            para("Estado de esta revision", styles["h2"]),
            para("Alcance: estrategia, arquitectura objetivo, seguridad, estandar y gates de ejecucion antes de Fase 2. No se autorizan nuevas superficies de producto hasta cerrar los gates descritos aqui.", styles["body"]),
            PageBreak(),
        ]
    )

    story += section(
        "1. Correccion de la tesis: que fue demostrado y que no",
        [
            "La evidencia de Fase 1 es material: el motor local compila, pasa sus gates y sus pruebas Docker reales demostraron tres comportamientos esenciales: una migracion incompatible se clasifica UNSAFE con SQLSTATE y receta; una migracion compatible llega a VERIFIED; y la ausencia de workload produce INCONCLUSIVE. La reproduccion deja un fallo accesible y lo limpia de forma dirigida.",
            "El gate externo registrado en docs/PHASE_1.md tambien informa 5 de 5 repositorios que completaron el pipeline, pero sigue siendo una serie de casos propia. Es evidencia de viabilidad y aprendizaje de producto, no una estimacion de prevalencia ni validacion independiente de mercado.",
            "La v0.2 describe como matriz objetivo A0/A1 x S0/S1, convivencia y rollback. El motor actual ejecuta el slice A0+S0 a A0+S1 y comprueba la buildabilidad de A1; no debe venderse como si ya hubiera probado A1+S0, coexistencia A0/A1+S1 o rollback despues de escrituras de A1. Cerrar esta diferencia es el primer objetivo del plan.",
        ],
        styles,
    )
    correction_rows = [
        [cell("Afirmacion", styles["tablehead"]), cell("Tratamiento v0.3", styles["tablehead"])],
        [cell("'Firmable'", styles["table"]), cell("El Bundle v1 es versionado y tiene provenance, pero no incluye firma ni atestacion verificable. Hasta incorporar ambas, usar 'preparado para firma', no 'firmado'.", styles["table"])],
        [cell("'Seguro por aislamiento'", styles["table"]), cell("La red interna y limites runtime son buenos controles. No bastan frente a Dockerfiles, config TypeScript o workloads no confiables que pueden ejecutar codigo. El modelo de amenaza debe distinguir repositorios confiables, PRs internos y forks.", styles["table"])],
        [cell("'No existe competencia'", styles["table"]), cell("No es demostrable con una busqueda. Atlas, Signadot y Speedscale cubren piezas fuertes. La hipotesis diferenciada es una semantica de transicion ejecutada mas un artefacto interoperable; debe probarse, no proclamarse.", styles["table"])],
        [cell("'Los agentes lo necesitan'", styles["table"]), cell("Hipotesis fuerte, apoyada por fallos conocidos de autoevaluacion. Requiere un benchmark de agentes y usuarios externos antes de convertirse en mensaje comercial absoluto.", styles["table"])],
    ]
    correction_table = Table(correction_rows, colWidths=[42 * mm, 132 * mm], repeatRows=1)
    correction_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [Spacer(1, 2 * mm), correction_table]

    story += section(
        "2. La oportunidad agentic, sin depender de una moda",
        [
            "La observacion correcta de la sesion de dogfooding no es que un agente necesite 'mas herramientas'. Es que un agente puede leer, detectar patrones y escribir fixes, pero no puede convertir una conjetura sobre un estado contrafactual en un hecho sin ejecutar el sistema. El defecto de una migracion faltante ilustra el limite: no esta necesariamente en el diff, sino en un estado de runtime que el diff no representa.",
            "La segunda observacion es mas general: los agentes tienden a declarar exito despues de que los tests habituales pasan. Anthropic documenta que la autoevaluacion es indulgente y que un evaluador separado es un multiplicador de calidad. Proof debe ser ese evaluador determinista para propiedades de release, no una segunda opinion de LLM.",
            "La tesis no debe basarse en una ventana especulativa de 1 a 3 anos ni en una fecha futura de especificacion MCP. Al 15 de julio de 2026, una cita a un supuesto release del 28 de julio de 2026 no es evidencia disponible. MCP es una interfaz importante, pero el activo durable es el contrato de evidencia, no el transporte.",
        ],
        styles,
    )
    story += bullets(
        [
            "Humano: reduce el riesgo de aprobar por intuicion un release stateful.",
            "Agente: impide que la declaracion de 'terminado' sustituya evidencia de estado final.",
            "CI: convierte una politica de merge en una decision trazable, repetible y revisable.",
            "Security y compliance: aporta provenance, alcance, incertidumbre y reproduccion; no reemplaza SAST, threat modeling ni revisiones de explotabilidad.",
        ],
        styles,
    )

    story += section(
        "3. Posicionamiento frente a la competencia: componer, no caricaturizar",
        [
            "Atlas analiza migraciones y detecta cambios destructivos, data-dependent e incompatibles. Es una capa estatica valiosa y debe ser un input de Proof, no un enemigo a reimplementar por orgullo. Signadot ofrece sandboxes aislados, pruebas E2E y comparacion baseline/sandbox. Speedscale controla replay y condiciones de comparacion. pgroll operacionaliza esquemas compatibles y reversibles.",
            "La apuesta diferenciada de Proof es unir la semantica de la transicion concreta con un recibo verificable: que version estaba desplegada, que datos iniciales se usaron, que migracion se aplico, que flujos fueron ejercitados, que writes cambio la aplicacion vieja/nueva y que incertidumbre permanece. Esa capa puede consumir analisis de Atlas, workloads de Signadot/Speedscale y estrategias de pgroll.",
            "Superar a Atlas no significa replicar mas reglas SQL. Significa responder una pregunta que una regla estatica no puede cerrar sola: 'en este estado de datos y con estos clientes desplegados, la transicion es operativa?'. A la vez, Proof debe integrar linting estatico para dar una respuesta rapida antes del runtime costoso.",
        ],
        styles,
    )
    competition_rows = [
        [cell("Capa", styles["tablehead"]), cell("Que se adopta", styles["tablehead"]), cell("Que Proof debe poseer", styles["tablehead"])],
        [cell("Atlas", styles["table"]), cell("Diagnosticos de riesgo semantico, politicas y salida compatible con CI/SARIF donde exista.", styles["table"]), cell("Seleccion dinamica, reproduccion A0/A1 x S0/S1 y evidencia de comportamiento real.", styles["table"])],
        [cell("Signadot", styles["table"]), cell("Entornos aislados, tests de integracion y comparacion baseline/sandbox.", styles["table"]), cell("Release graph, equivalencia de transicion y Bundle portable independiente del proveedor de entorno.", styles["table"])],
        [cell("Speedscale", styles["table"]), cell("Captura/replay, configuracion de exito y control de ruido.", styles["table"]), cell("Contrato de coverage de release, efectos SQL, redaccion y reproduccion de hallazgos.", styles["table"])],
        [cell("pgroll", styles["table"]), cell("Primitivas expand/contract y esquema reversible.", styles["table"]), cell("Prueba de que el codigo real usa la compatibilidad prometida y plan de retiro seguro.", styles["table"])],
    ]
    competition_table = Table(competition_rows, colWidths=[26 * mm, 70 * mm, 78 * mm], repeatRows=1)
    competition_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [Spacer(1, 2 * mm), competition_table, PageBreak()]

    story += section(
        "4. Nueva tesis central: Proof como Evidence Plane",
        [
            "Proof debe ser una capa de evidencia de cambios, no una coleccion de comandos ni un orquestador de agentes. Recibe una afirmacion verificable, selecciona el nivel de aseguramiento adecuado, ejecuta en un sobre seguro, devuelve un veredicto tipado y deja artefactos cuya procedencia puede revisarse sin confiar en el agente que los solicito.",
            "El principio se extiende mas alla de releases de base de datos: toda afirmacion importante debe expresar sujeto, transicion, invariantes, cobertura, sobre de ejecucion, evidencia y limites. El motor inicial sigue siendo Postgres/Prisma. La abstraccion se extrae de su semantica probada, no antes.",
        ],
        styles,
    )
    diagram = """CHANGE / PR / INCIDENT\n        |\n        v\n  proof plan  -> riesgo, costo, coverage requerida\n        |\n        +--> static evidence (Atlas-compatible, diff, drift)\n        +--> dynamic evidence (transiciones, workload, SQL effects)\n        +--> policy evidence (approvals, excepciones, expiracion)\n        |\n        v\n  Proof Bundle v2 -> CI / GitHub / Codex / Claude / Copilot / humano\n        |\n        v\n  verify -> remediate -> re-verify -> attestate"""
    story += [Preformatted(diagram, styles["mono"])]
    pillars = [
        [cell("Pilar", styles["tablehead"]), cell("Regla de diseno", styles["tablehead"])],
        [cell("Independencia", styles["table"]), cell("Quien escribe el cambio no decide el gate. Los LLM explican y proponen; el runtime y las politicas emiten hechos.", styles["table"])],
        [cell("Progresividad", styles["table"]), cell("El costo del verify se ajusta al riesgo. Un triage rapido no suplanta una prueba completa; decide si vale pagarla.", styles["table"])],
        [cell("Interoperabilidad", styles["table"]), cell("MCP es un transporte. Bundle, schemas, fixtures de conformidad y atestaciones deben poder vivir fuera de MCP.", styles["table"])],
        [cell("Honestidad", styles["table"]), cell("Toda cobertura omitida, dato no representativo, flake, permiso denegado o riesgo no probado queda tipado. No se colapsa en verde.", styles["table"])],
    ]
    pillar_table = Table(pillars, colWidths=[35 * mm, 139 * mm], repeatRows=1)
    pillar_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [Spacer(1, 2 * mm), pillar_table]

    story += section(
        "5. La escalera de aseguramiento: velocidad sin fingir certeza",
        [
            "La latencia de 3 a 15 minutos es la restriccion que puede matar la adopcion agentic. La respuesta no es debilitar el gate final, sino separar decision rapida de demostracion completa. Cada nivel publica que sabe, cuanto cuesta y que no puede concluir.",
        ],
        styles,
    )
    ladder_rows = [
        [cell("Nivel", styles["tablehead"]), cell("Objetivo", styles["tablehead"]), cell("Salida", styles["tablehead"]), cell("Meta", styles["tablehead"])],
        [cell("L0 - Inspect", styles["table"]), cell("Detectar diff, drift, service ownership y rutas potenciales. Cero build.", styles["table"]), cell("Plan tipado y declaracion de riesgo; nunca VERIFIED.", styles["table"]), cell("p95 < 30 s", styles["table"])],
        [cell("L1 - Triage", styles["table"]), cell("Correr analizadores estaticos, sanity checks, cache/provenance y un smoke selectivo.", styles["table"]), cell("REQUIRES_FULL_PROOF o riesgo reducido con limites claros.", styles["table"]), cell("p95 < 2 min", styles["table"])],
        [cell("L2 - Transition", styles["table"]), cell("Ejecutar la matriz relevante sobre datos y workload aislados.", styles["table"]), cell("VERIFIED, UNSAFE o INCONCLUSIVE con Bundle completo.", styles["table"]), cell("p95 < 10 min", styles["table"])],
        [cell("L3 - Release", styles["table"]), cell("Evidence de rolling, rollback, policy y atestacion en runner confiable.", styles["table"]), cell("Decision de merge/release firmada y con expiracion.", styles["table"]), cell("selectivo", styles["table"])],
    ]
    ladder_table = Table(ladder_rows, colWidths=[28 * mm, 57 * mm, 63 * mm, 26 * mm], repeatRows=1)
    ladder_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [Spacer(1, 2 * mm), ladder_table]

    story += section(
        "6. Fase 1.X - Assurance Kernel: requisito previo a Fase 2",
        [
            "No abrir GitHub App, dashboard ni managed compute antes de convertir el motor actual en un kernel de confianza. La fase se llama 1.X para dejar claro que fortalece la cuña y no expande el catalogo de producto. Puede terminar con un producto muy poderoso dentro de una pregunta estrecha: demostrar seguridad de una transicion stateful.",
        ],
        styles,
    )
    work_rows = [
        [cell("Orden", styles["tablehead"]), cell("Workstream", styles["tablehead"]), cell("Entregable y gate de salida", styles["tablehead"])],
        [cell("P0", styles["table"]), cell("Verdad de alcance", styles["table"]), cell("Matriz implementada se publica por estado; claims y UI no exceden A0+S1 hasta que cada estado faltante tenga E2E real y fixture negativo.", styles["table"])],
        [cell("P0", styles["table"]), cell("Sobre seguro", styles["table"]), cell("Perfiles trusted / internal PR / fork; runner efimero, red deny-by-default, no secrets en ejecucion de fork y configuracion declarativa o aislada. Threat model y pruebas de escape aprobadas.", styles["table"])],
        [cell("P0", styles["table"]), cell("Datos y privacidad", styles["table"]), cell("Redaccion por politica antes de persistir, allowlist de headers/campos, limites, retencion y prueba de que secretos no entran al Bundle ni al log.", styles["table"])],
        [cell("P1", styles["table"]), cell("Fast path", styles["table"]), cell("proof plan/inspect y L1 triage con cache, cancelacion y clasificacion estatica. En benchmark externo, p95 < 2 min para resultados parciales utiles.", styles["table"])],
        [cell("P1", styles["table"]), cell("Matriz de transicion", styles["table"]), cell("A1+S0, coexistencia A0/A1+S1, final A1+S1 y rollback A0 despues de writes A1. Cada estado tiene assertion y reproduccion.", styles["table"])],
        [cell("P1", styles["table"]), cell("Bundle v2", styles["table"]), cell("Schema estable, semantica de coverage, evidence references content-addressed, runner envelope, redaction y attestation opcional. Validator y fixtures de conformidad abiertos.", styles["table"])],
        [cell("P2", styles["table"]), cell("Agent fitness", styles["table"]), cell("Eval suite con Codex, Claude Code y Copilot cuando sea accesible: uso correcto, costo, reintentos, no-declaracion-prematura y comprension de INCONCLUSIVE.", styles["table"])],
        [cell("P2", styles["table"]), cell("Interoperabilidad", styles["table"]), cell("Adapter Atlas/SARIF de entrada y export JSON/SARIF de salida donde semantica aplique; segundo consumidor independiente del Bundle antes de reclamar estandar.", styles["table"])],
    ]
    work_table = Table(work_rows, colWidths=[15 * mm, 37 * mm, 122 * mm], repeatRows=1)
    work_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [Spacer(1, 2 * mm), work_table, PageBreak()]

    story += section(
        "7. Proof Bundle v2: el formato tiene que preceder al estandar",
        [
            "Un formato no se vuelve estandar porque una herramienta le asigna un nombre. Se vuelve estandar cuando productores y consumidores distintos intercambian el mismo hecho sin perder significado. Por eso Bundle v2 debe ser primero una especificacion publica, un validador, fixtures de conformidad y una implementacion de referencia; la gobernanza se abre solo despues de uso externo real.",
            "El Bundle no debe mezclar evidencia sensible con su resumen. El objeto principal contiene hashes, referencias y metadatos de redaccion. Los cuerpos necesarios para reproduccion permanecen en un artifact store bajo una politica explicita o se reemplazan por fixtures minimizados.",
        ],
        styles,
    )
    bundle = """ProofBundle v2 (resumen conceptual)\n- subject: base/head, deploy target, release-graph transition\n- claim: invariant, policy, severity and expiry\n- verdict: VERIFIED | UNSAFE | INCONCLUSIVE | NOT_APPLICABLE\n- coverage: routes, flows, writes, states, omissions and confidence\n- execution: runner identity, sandbox profile, image/plugin digests, timestamps\n- evidenceRefs: content-addressed artifacts plus redaction classification\n- remediation: deterministic steps, human approvals and next actions\n- attestation: optional signed envelope bound to input/output hashes"""
    story += [Preformatted(bundle, styles["mono"])]
    story += bullets(
        [
            "Definir semantica, no solo JSON: cuando una coverage es 'complete', que significa 'verified', cuando vence una approval y que invalida un Bundle.",
            "Separar un Bundle local no firmado de una atestacion de CI/BYOC firmada. Nunca permitir que la firma esconda coverage insuficiente.",
            "Publicar un CLI validator, JSON Schema, changelog de compatibilidad y corpus de Bundles validos/invalidos.",
            "Aceptar evidencia externa con namespace y emisor, sin convertirla automaticamente en una conclusion de Proof.",
        ],
        styles,
    )

    story += section(
        "8. Seguridad y privacidad: el verificador debe merecer confianza",
        [
            "La v0.2 acierta al pedir egress bloqueado, OIDC, aislamiento, plugins firmados y sanitizacion. La implementacion actual revela por que estas no son notas futuras: proof.config.ts puede ser TypeScript ejecutable, el workload es un proceso local y Docker build ejecuta un Dockerfile del repo. La herramienta es segura para trabajo en un repositorio confiable; no debe presentarse como sandbox suficiente para codigo hostil hasta que exista un sobre de ejecucion independiente.",
            "Codex y Claude convergen en la misma leccion: aislamiento de filesystem y de red deben operar juntos. MCP agrega otra superficie: scopes, aprobaciones, tool allowlists, OAuth de recursos remotos y proteccion contra confused deputy. Proof debe tratar sus tools como una API de alto impacto, aunque hoy sean locales.",
        ],
        styles,
    )
    security_rows = [
        [cell("Amenaza", styles["tablehead"]), cell("Regla de diseno previa a Fase 2", styles["tablehead"])],
        [cell("PR o plugin malicioso", styles["table"]), cell("No ejecutar en host del desarrollador ni con secretos. Runner efimero, rootless cuando sea posible, sin Docker socket expuesto a la app, filesystem minimo y egress por allowlist.", styles["table"])],
        [cell("Exfiltracion en workload/traffic", styles["table"]), cell("Clasificar datos, redactar antes de disco, negar headers sensibles por default, snapshots minimizados y pruebas negativas de fuga. BYOC es una opcion de privacidad, no excusa para omitir controles.", styles["table"])],
        [cell("Bundle falsificado o stale", styles["table"]), cell("Atestar inputs/outputs, vincular SHA exactos, expirar por cambio de diff/config/policy, separar signer de executor y verificar offline.", styles["table"])],
        [cell("MCP con privilegio excesivo", styles["table"]), cell("Tools declaradas read-only o side-effectful, scopes por tool, approval mode conservador, timeouts/costos visibles y ningun secreto en stdout o instrucciones del servidor.", styles["table"])],
        [cell("Falso verde", styles["table"]), cell("INCONCLUSIVE es un resultado de primera clase; policy no lo transforma en VERIFIED. Las excepciones son firmadas, acotadas, con motivo y expiracion.", styles["table"])],
    ]
    security_table = Table(security_rows, colWidths=[48 * mm, 126 * mm], repeatRows=1)
    security_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [Spacer(1, 2 * mm), security_table]

    story += section(
        "9. Interfaz para agentes: contrato operacional, no chat",
        [
            "AGENTS.md, skills y MCP son superficies complementarias. AGENTS.md explica la regla durable del repositorio; una skill empaqueta el procedimiento; MCP expone datos y acciones con schema; CI aplica la politica. Proof debe publicar la misma semantica en las cuatro, sin pedir a un modelo que interprete prosa para decidir el gate.",
            "El contrato debe impedir el fracaso comun: 'los tests pasan, listo'. Si un diff toca una superficie de riesgo, proof plan devuelve las afirmaciones requeridas; el harness no puede marcar la tarea como release-ready mientras falte una evidencia vigente. El agente puede decidir como corregir; no puede autoemitir la prueba.",
        ],
        styles,
    )
    agent_rows = [
        [cell("Momento", styles["tablehead"]), cell("Contrato propuesto", styles["tablehead"]), cell("No hacer", styles["tablehead"])],
        [cell("Antes de editar", styles["table"]), cell("proof_plan explica riesgo, costo, coverage y nivel L0-L3 requerido.", styles["table"]), cell("No lanzar un full verify por cada razonamiento o cambio irrelevante.", styles["table"])],
        [cell("Durante la tarea", styles["table"]), cell("proof_inspect/triage alimenta el loop rapido; nextActions son objetos tipados que el agente puede ejecutar o escalar.", styles["table"]), cell("No transformar recomendaciones LLM en hechos ni ocultar un INCONCLUSIVE.", styles["table"])],
        [cell("Antes de terminar", styles["table"]), cell("proof_release_verify produce Bundle, policy decision y evidencia resumida; CI valida vigencia y firma.", styles["table"]), cell("No permitir que el mismo actor modifique tests/policy y apruebe el resultado sin un control independiente.", styles["table"])],
        [cell("Despues del incidente", styles["table"]), cell("proof_reproduce crea un capsule sanitizado; un humano aprueba convertirlo en regresion/invariante.", styles["table"]), cell("No capturar trafico productivo o secretos por defecto.", styles["table"])],
    ]
    agent_table = Table(agent_rows, colWidths=[29 * mm, 81 * mm, 64 * mm], repeatRows=1)
    agent_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [Spacer(1, 2 * mm), agent_table, PageBreak()]

    story += section(
        "10. Validacion: las hipotesis deben poder perder",
        [
            "La categoria no se valida con demos internas. La unidad de validacion pasa a ser una tarea real, un repositorio real y una afirmacion de release real. Se mide tanto la calidad del motor como la capacidad de distintos harnesses de usarlo sin asistencia. El objetivo no es maximizar llamados a Proof; es minimizar cambios riesgoso sin evidencia y tiempo desperdiciado.",
        ],
        styles,
    )
    metric_rows = [
        [cell("Hipotesis", styles["tablehead"]), cell("Experimento", styles["tablehead"]), cell("Gate", styles["tablehead"])],
        [cell("El fast path cambia el loop", styles["table"]), cell("20 repos externos representativos; medir L0/L1, cache, cancelacion y cuantos L2 eran necesarios.", styles["table"]), cell("p95 L1 < 2 min y adopcion sin degradar precision.", styles["table"])],
        [cell("El proof reduce falso exito agente", styles["table"]), cell("Corpus versionado de migraciones seguras/inseguras, drift y dependencias; ejecutar con al menos dos harnesses y humano baseline.", styles["table"]), cell("Menos declaraciones prematuras y mas hallazgos cerrados sin aumento inaceptable de flakes.", styles["table"])],
        [cell("El Bundle es interoperable", styles["table"]), cell("Un productor externo o adapter y un consumidor externo validan el schema/conformance corpus sin usar el CLI principal.", styles["table"]), cell("Dos implementaciones o un consumidor independiente antes de hablar de estandar.", styles["table"])],
        [cell("El gate merece Enforce", styles["table"]), cell("Pilotos con Observe/Recommend antes de bloquear, revision humana de cada UNSAFE/INCONCLUSIVE y cada override.", styles["table"]), cell("Falso positivo bloqueante < 3%, reproducibilidad > 95%, politica de excepcion usada correctamente.", styles["table"])],
        [cell("Se puede vender", styles["table"]), cell("Entrevistas y pilotos sobre un servicio stateful donde haya costo de release; comparar contra su proceso actual y herramientas adyacentes.", styles["table"]), cell("Un comprador atribuye valor a prevencion o confianza, no solo a una demo tecnica.", styles["table"])],
    ]
    metric_table = Table(metric_rows, colWidths=[45 * mm, 83 * mm, 46 * mm], repeatRows=1)
    metric_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [Spacer(1, 2 * mm), metric_table]

    story += section(
        "11. Decisiones y backlog que esta revision agrega",
        [
            "Estas decisiones no habilitan implementacion automatica. Ordenan la investigacion y convierten el paso a Fase 2 en una consecuencia de gates, no de entusiasmo.",
        ],
        styles,
    )
    decisions_rows = [
        [cell("ID", styles["tablehead"]), cell("Decision", styles["tablehead"]), cell("Estado", styles["tablehead"]), cell("Revision", styles["tablehead"])],
        [cell("D-018", styles["table"]), cell("Proof es un Evidence Plane neutral a agente/humano/CI; no un framework de agentes.", styles["table"]), cell("Aceptada", styles["table"]), cell("Al finalizar 1.X", styles["table"])],
        [cell("D-019", styles["table"]), cell("Fase 1.X Assurance Kernel debe cerrar alcance, seguridad, Bundle v2, fast path y matriz antes de Fase 2.", styles["table"]), cell("Aceptada", styles["table"]), cell("Cada gate P0/P1", styles["table"])],
        [cell("D-020", styles["table"]), cell("Estandar abierto se inicia como especificacion y conformance suite; no se declara estandar antes de pluralidad de implementaciones/consumidores.", styles["table"]), cell("Aceptada", styles["table"]), cell("Primer consumidor externo", styles["table"])],
        [cell("D-021", styles["table"]), cell("Atlas y otros analizadores son inputs complementarios. Proof compite por evidencia de transicion, no por reimplementar todos los linters.", styles["table"]), cell("Aceptada", styles["table"]), cell("Adapter de entrada", styles["table"])],
        [cell("D-022", styles["table"]), cell("Un claim de seguridad exige un secure execution envelope y redaccion comprobable; local trusted y fork untrusted son productos distintos.", styles["table"]), cell("Propuesta", styles["table"]), cell("Threat model RFC", styles["table"])],
    ]
    decisions_table = Table(decisions_rows, colWidths=[16 * mm, 98 * mm, 26 * mm, 34 * mm], repeatRows=1)
    decisions_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#243B53")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#C8D1DC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FAFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [Spacer(1, 2 * mm), decisions_table]
    story += [para("Backlog nuevo", styles["h2"])]
    story += bullets(
        [
            "I-014 - Proof Plan and Assurance Ladder - DESIGN - definir schema, selector de riesgo, costos y UX L0-L3.",
            "I-015 - Proof Bundle v2 and conformance suite - DESIGN - especificacion semantica, redaction, provenance y validator.",
            "I-016 - Secure Proof Runner - RESEARCH - RFC de threat model, perfiles de confianza y pruebas de aislamiento.",
            "I-017 - Agent Fitness Benchmark - RESEARCH - corpus, harnesses, metricas de declaracion prematura y evaluacion de tools.",
            "I-018 - Static Evidence Adapters - RESEARCH - Atlas/SARIF, drift detector y reglas propias solo cuando haya evidencia de hueco.",
            "I-019 - Release Matrix Completion - COMMITTED - A1+S0, coexistencia, A1+S1 y rollback con writes de A1 antes de Fase 2.",
        ],
        styles,
    )

    story += section(
        "12. Fuentes y nota metodologica",
        [
            "Se revisaron fuentes primarias y documentacion oficial el 15 de julio de 2026. El analisis de competencia es direccional y no prueba ausencia global de un producto equivalente. Las afirmaciones de producto de esta tesis siguen siendo hipotesis hasta que los experimentos de la seccion 10 las validen.",
        ],
        styles,
    )
    sources = [
        "[S11] OpenAI Codex Security - scan phases, coverage, validation and portable artifacts. https://learn.chatgpt.com/docs/security/plugin/scans",
        "[S12] OpenAI Codex - MCP capabilities, server instructions and per-tool approval controls. https://learn.chatgpt.com/docs/extend/mcp",
        "[S13] OpenAI Codex - sandbox, approvals and network isolation. https://learn.chatgpt.com/docs/agent-approvals-security",
        "[S14] Anthropic - Demystifying evals for AI agents. https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents",
        "[S15] Anthropic - Writing effective tools for AI agents. https://www.anthropic.com/engineering/writing-tools-for-agents",
        "[S16] Anthropic - Harness design for long-running application development. https://www.anthropic.com/engineering/harness-design-long-running-apps",
        "[S17] Anthropic - sandboxing with filesystem and network isolation. https://www.anthropic.com/engineering/claude-code-sandboxing",
        "[S18] Model Context Protocol - authorization and resource-bound OAuth. https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization",
        "[S19] GitHub - agent instructions and repository custom instructions. https://docs.github.com/en/copilot/reference/custom-instructions-support",
        "[S20] Atlas - migration analyzers for destructive, data-dependent and incompatible changes. https://atlasgo.io/lint/analyzers",
        "[S21] Signadot - sandboxes, E2E validation and baseline/sandbox Smart Diff. https://www.signadot.com/docs/overview",
        "[S22] Speedscale - replay test configuration and success conditions. https://docs.speedscale.com/concepts/test_config/",
        "[S23] pgroll - schema versioning and reversible Postgres migrations. https://pgroll.com/docs/latest",
    ]
    story += [para(item, styles["small"]) for item in sources]
    story += [Spacer(1, 4 * mm), para("Cierre v0.3", styles["h2"])]
    story += [para("La ambicion correcta no es sumar agentes, dashboards o analisis para parecer mas completo. Es volver inevitable una disciplina: ninguna afirmacion de release importante se acepta sin evidencia proporcionada al riesgo, interpretable por cualquiera y segura de ejecutar. Si Proof logra eso primero en un slice estrecho y lo abre como contrato, puede convertirse en infraestructura de confianza del desarrollo agentic en lugar de una feature de un agente.", styles["body"])]

    document.build(story, onFirstPage=doc_header_footer, onLaterPages=doc_header_footer)


def merge_with_thesis() -> None:
    writer = PdfWriter()
    for source in (SOURCE, ADDENDUM):
        reader = PdfReader(str(source))
        for page in reader.pages:
            writer.add_page(page)
    writer.add_metadata({
        "/Title": "Tesis de Producto - Developer Reliability Platform v0.3",
        "/Author": "Proof",
        "/Subject": "Addendum estrategico: Proof beyond agents",
        "/Keywords": "release safety, evidence, agents, MCP, reliability",
    })
    with FINAL.open("wb") as output:
        writer.write(output)


if __name__ == "__main__":
    if not SOURCE.exists():
        raise SystemExit(f"No existe la tesis fuente: {SOURCE}")
    build_addendum()
    merge_with_thesis()
    print(FINAL)
