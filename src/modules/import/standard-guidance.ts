/**
 * FLF-459 (business-flow §3.1.1 lớp 2): câu hướng dẫn của **mẫu chuẩn** (mẫu SRS Report3 dùng làm cấu trúc chuẩn của FlintFlow,
 * `fixtures/fpt-report3-blank-template.docx`), đã bỏ ngoặc. Đoạn trong file upload trùng / gần trùng một câu ở đây là chữ hướng
 * dẫn chắc chắn, không cần thêm dấu hiệu định dạng. Mẫu trong thư viện org bổ sung câu của chúng lúc import (`import.service`).
 */
export const STANDARD_GUIDANCE: readonly string[] = Object.freeze([
  "Gives the overall description about the product with some introduction and the context diagram. The context diagram presents the boundary and connections between the system you’re developing and everything else in the universe. This identifies external entities (or terminators – software, hardware, human components, and other systems) outside the system that interface to it in some way, as well as data, control, and material flows between the terminators and the system.",
  "An actor is a person (or sometimes another software system or a hardware device) that interacts with the system to perform a use case. Following are some questions you might ask to help user representatives identify actors",
  "A use case (UC) describes a sequence of interactions between a system and an external actor that results in the actor being able to achieve some outcome of value. The names of use cases are always written in the form of a verb followed by an object. Select strong, descriptive names to make it evident from the name that the use case will deliver something valuable for some user",
  "Provide the UC diagram(s) to show the actor-UCs and UC-UC relationships like the sample below. You can have multiple UC diagrams for the system",
  "Provide functionality overview of software system: screen flow, screen descriptions, system user roles, screen authorization, non-screen functions, ERD",
  "This part shows the system screens and the relationship among screens. You can draw the Screens Flow for the system in the form of diagram as below. Please note that beside the normal flat screen, we might have the oval notation for pop-up screen (Import Order) or a screen with multiple information tab (Order Details), etc. You may also use text or background format for different visuality purpose",
  "Provide the descriptions for the screens in the Screens Flow above",
  "Provide the system roles authorization to the system features (down to screens, and event to the screen activities if applicable) in the table form as below – replace Role1, Role2,… with your specific system user role names",
  "Provide the descriptions for the non-screen system functions, i.e batch/cron job, service, API, etc.",
  "Provide the entity relationship diagram and the entity descriptions in the table format as below",
  "A function can be a screen or a non-screen function (listed in the part 3.1.5 above). In this part, you need to provide the details on the related function, focus on mentioning below information",
  "This section provides information to ensure that the system will communicate properly with users and with external hardware or software/system elements.",
  "List all the required system characteristics (quality attributes) specification. Some of the possible attributes are provided with the guide/descriptions are mentioned here",
  "This section includes all those requirements that affect usability. For example, specify the required training time for a normal users and a power user to become productive at particular operations specify measurable task times for typical tasks or base the new system’s usability requirements on other systems that the users know and like specify requirement to conform to common usability standards, such as IBM’s CUA standards Microsoft’s GUI standards",
  "Requirements for reliability of the system should be specified here. Some suggestions follow:",
  "The system’s performance characteristics are outlined in this section. Include specific response times. Where applicable, reference related Use Cases by name.",
  "Provide business rules, common requirements, or other extra requirements information here",
  "Provide common business rules that you must follow. The information can be provided in the table format as the sample below",
  "Fill all the common requirements here.."
])
